/**
 * Gemini AI service.
 * Generates responses using Google's Gemini API via the official SDK (@google/genai).
 * Validates and sanitizes multi-turn conversation history to ensure alternating user/model turns.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { ConversationEntry } from '../types/whatsapp';
import { logger } from '../utils/logger';

const genai = new GoogleGenAI({ apiKey: config.geminiApiKey });

export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export interface GenerateReplyParams {
  message: string;
  senderName?: string;
  chatId: string;
  history: ConversationEntry[];
}

/**
 * Sanitize and normalize conversation history for the Gemini API.
 * Ensures:
 * - Roles are mapped: assistant -> model, user -> user
 * - Invalid roles (system, bot, ai, etc.) are filtered out
 * - Empty, undefined, or null text entries are removed
 * - Consecutive messages of the same role are merged to maintain strict alternating turns
 * - Conversation history starts with 'user'
 * - Conversation history ends with 'model' (so appending current user prompt forms valid sequence)
 * - Limited to maxHistoryMessages pairs
 */
export function sanitizeGeminiHistory(
  history: ConversationEntry[],
  maxPairs = config.maxHistoryMessages
): GeminiContent[] {
  if (!history || !Array.isArray(history) || history.length === 0) {
    return [];
  }

  const normalizedTurns: GeminiContent[] = [];

  for (const entry of history) {
    if (!entry) continue;

    // 1. Role mapping
    const rawRole = (entry.role || '').toLowerCase().trim();
    let role: 'user' | 'model' | null = null;
    if (rawRole === 'user') {
      role = 'user';
    } else if (rawRole === 'model' || rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'ai') {
      role = 'model';
    }

    if (!role) {
      continue; // Skip invalid or system roles
    }

    // 2. Text extraction
    const rawText = (typeof entry.content === 'string' ? entry.content : (entry as any).text) || '';
    const text = rawText.trim();
    if (!text) {
      continue; // Skip empty text
    }

    // 3. Merge consecutive same-role turns to preserve strict alternation
    const prevTurn = normalizedTurns[normalizedTurns.length - 1];
    if (prevTurn && prevTurn.role === role) {
      prevTurn.parts[0].text = `${prevTurn.parts[0].text}\n${text}`;
    } else {
      normalizedTurns.push({
        role,
        parts: [{ text }],
      });
    }
  }

  // 4. Ensure conversation history begins with role 'user'
  while (normalizedTurns.length > 0 && normalizedTurns[0].role !== 'user') {
    normalizedTurns.shift();
  }

  // 5. Ensure conversation history ends with role 'model'
  // (Appending the incoming message will then create a valid 'model' -> 'user' transition)
  while (normalizedTurns.length > 0 && normalizedTurns[normalizedTurns.length - 1].role !== 'model') {
    normalizedTurns.pop();
  }

  // 6. Limit history according to maxPairs
  const maxTurns = maxPairs * 2;
  let result = normalizedTurns;
  if (result.length > maxTurns) {
    result = result.slice(-maxTurns);
    while (result.length > 0 && result[0].role !== 'user') {
      result.shift();
    }
  }

  return result;
}

export class GeminiProviderError extends Error {
  public readonly isRateLimit: boolean;
  public readonly isServerError: boolean;
  public readonly isTimeout: boolean;
  public readonly statusCode?: number | string;

  constructor(
    message: string,
    options: {
      isRateLimit?: boolean;
      isServerError?: boolean;
      isTimeout?: boolean;
      statusCode?: number | string;
    } = {}
  ) {
    super(message);
    this.name = 'GeminiProviderError';
    this.isRateLimit = Boolean(options.isRateLimit);
    this.isServerError = Boolean(options.isServerError);
    this.isTimeout = Boolean(options.isTimeout);
    this.statusCode = options.statusCode;
  }
}

/**
 * Classify Gemini error for logging and fallback decisions.
 */
export function parseGeminiError(err: unknown): {
  isRateLimit: boolean;
  isServerError: boolean;
  isTimeout: boolean;
  status: string | number;
  code: string | number;
  sanitizedMsg: string;
} {
  const error = (err || {}) as any;
  const status = error.status || error.statusCode || error.response?.status || 'unknown';
  const code = error.code || error.error?.code || 'unknown';
  const rawMsg = error.message || String(error);
  const sanitizedMsg = rawMsg
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
    .replace(/key=[^&\s]+/g, 'key=[REDACTED]');

  const strForCheck = `${status} ${code} ${sanitizedMsg}`.toLowerCase();

  const isTimeout =
    strForCheck.includes('timeout') ||
    strForCheck.includes('deadline_exceeded') ||
    strForCheck.includes('etimedout');

  const isRateLimit =
    !isTimeout &&
    (status === 429 ||
      code === 429 ||
      strForCheck.includes('429') ||
      strForCheck.includes('resource_exhausted') ||
      strForCheck.includes('quota') ||
      strForCheck.includes('rate limit'));

  const isServerError =
    !isTimeout &&
    !isRateLimit &&
    (status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      code === 500 ||
      code === 503 ||
      strForCheck.includes('500') ||
      strForCheck.includes('502') ||
      strForCheck.includes('503') ||
      strForCheck.includes('504') ||
      strForCheck.includes('unavailable') ||
      strForCheck.includes('internal') ||
      strForCheck.includes('overloaded'));

  return {
    isRateLimit,
    isServerError,
    isTimeout,
    status,
    code,
    sanitizedMsg,
  };
}

async function executeModelCall(
  modelName: string,
  contents: GeminiContent[],
  configObj: Record<string, unknown>
): Promise<string> {
  const response = await genai.models.generateContent({
    model: modelName,
    contents,
    config: configObj,
  });

  const text = response.text;
  if (!text || !text.trim()) {
    logger.gemini.warn('Gemini returned empty response');
    throw new Error('Gemini returned empty response text');
  }
  return text.trim();
}

/**
 * Generate a reply using Google Gemini.
 */
export async function generateReply(params: GenerateReplyParams): Promise<string> {
  const { message, senderName, chatId, history } = params;

  // Truncate input
  const truncatedMessage = message.substring(0, config.maxInputChars);

  // Format current prompt
  let currentPrompt = truncatedMessage;
  if (senderName) {
    currentPrompt = `[${senderName}]: ${truncatedMessage}`;
  }

  // Sanitize previous history
  const sanitizedHistory = sanitizeGeminiHistory(history);

  logger.gemini.info(`history entries=${sanitizedHistory.length}`);

  // Build final contents: sanitized history + current user message
  const contents: GeminiContent[] = [
    ...sanitizedHistory,
    {
      role: 'user',
      parts: [{ text: currentPrompt }],
    },
  ];

  // Configure request options
  const configObj: Record<string, unknown> = {
    maxOutputTokens: 2048,
    temperature: 0.7,
    topP: 0.9,
  };

  // Only pass systemInstruction if configured and non-empty
  if (config.systemPrompt && config.systemPrompt.trim() !== '') {
    configObj.systemInstruction = config.systemPrompt.trim();
  }

  const primaryModel = config.geminiModel;

  // Primary attempt
  logger.gemini.info('request started');
  try {
    const reply = await executeModelCall(primaryModel, contents, configObj);
    logger.gemini.info('success');
    logger.gemini.info(`Reply generated: ${reply.length} chars`);
    return reply;
  } catch (firstErr) {
    let parsed = parseGeminiError(firstErr);
    logger.gemini.error(
      `request failed\nstatus=${parsed.status}\ncode=${parsed.code}\nmessage=${parsed.sanitizedMsg}`
    );

    // If 429: max 1 quick retry with <= 200ms delay
    if (parsed.isRateLimit) {
      logger.gemini.warn('provider rate limit 429');
      await new Promise((r) => setTimeout(r, 100));
      logger.gemini.info('request started');
      try {
        const retryReply = await executeModelCall(primaryModel, contents, configObj);
        logger.gemini.info('success');
        logger.gemini.info(`Reply generated: ${retryReply.length} chars`);
        return retryReply;
      } catch (retryErr) {
        parsed = parseGeminiError(retryErr);
        logger.gemini.error(
          `request failed\nstatus=${parsed.status}\ncode=${parsed.code}\nmessage=${parsed.sanitizedMsg}`
        );
        if (parsed.isRateLimit) {
          logger.gemini.warn('provider rate limit 429');
        } else if (parsed.isServerError) {
          logger.gemini.error('provider server error');
        } else if (parsed.isTimeout) {
          logger.gemini.error('timeout');
        }
      }
    } else if (parsed.isServerError) {
      logger.gemini.error('provider server error');
    } else if (parsed.isTimeout) {
      logger.gemini.error('timeout');
    }

    // Try fallback model if configured and different from primary model
    const fallbackModel = (config.geminiFallbackModel || '').trim();
    if (fallbackModel && fallbackModel !== primaryModel) {
      logger.gemini.info(`request started (fallback model: ${fallbackModel})`);
      try {
        const fallbackReply = await executeModelCall(fallbackModel, contents, configObj);
        logger.gemini.info('success');
        logger.gemini.info(`Reply generated: ${fallbackReply.length} chars`);
        return fallbackReply;
      } catch (fallbackErr) {
        const parsedFallback = parseGeminiError(fallbackErr);
        logger.gemini.error(
          `request failed\nstatus=${parsedFallback.status}\ncode=${parsedFallback.code}\nmessage=${parsedFallback.sanitizedMsg}`
        );
        if (parsedFallback.isRateLimit) {
          logger.gemini.warn('provider rate limit 429');
        } else if (parsedFallback.isServerError) {
          logger.gemini.error('provider server error');
        } else if (parsedFallback.isTimeout) {
          logger.gemini.error('timeout');
        }

        throw new GeminiProviderError(parsedFallback.sanitizedMsg, {
          isRateLimit: parsedFallback.isRateLimit,
          isServerError: parsedFallback.isServerError,
          isTimeout: parsedFallback.isTimeout,
          statusCode: parsedFallback.status,
        });
      }
    }

    // Throw classified error
    throw new GeminiProviderError(parsed.sanitizedMsg, {
      isRateLimit: parsed.isRateLimit,
      isServerError: parsed.isServerError,
      isTimeout: parsed.isTimeout,
      statusCode: parsed.status,
    });
  }
}
