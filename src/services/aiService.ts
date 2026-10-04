/**
 * Unified AI Service with Multi-Model Automatic Failover.
 * Supports VPSMurah OpenAI-compatible API and Google Gemini direct SDK.
 *
 * Model Chain Priority:
 * 1. gemini-38
 * 2. gemini-37
 * 3. gemini-36
 * 4. gemini-35
 * 5. qwen3-flash
 * 6. gpt-5-mini
 * 7. gpt-4o-mini
 * 8. mistral-small
 */

import OpenAI from 'openai';
import { config, getVpsmurahAiApiKey } from '../config';
import { ConversationEntry } from '../types/whatsapp';
import { logger } from '../utils/logger';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateReplyParams {
  message: string;
  senderName?: string;
  chatId: string;
  history: ConversationEntry[];
}

// Diagnostics state
let lastUsedModel = '';
let lastAIStatus: 'success' | 'failed' | 'idle' = 'idle';

// Allow overriding OpenAI client for testing
let testOpenAIClient: OpenAI | null = null;

export function setTestOpenAIClient(client: OpenAI | null): void {
  testOpenAIClient = client;
}

export function resetAIState(): void {
  lastUsedModel = '';
  lastAIStatus = 'idle';
  testOpenAIClient = null;
}

export function getAIDiagnostics(): {
  aiProvider: string;
  primaryModel: string;
  lastUsedModel: string;
  lastAIStatus: string;
} {
  const primaryModel =
    config.aiProvider === 'vpsmurah'
      ? config.aiModelChain[0] || 'none'
      : config.geminiModel;

  return {
    aiProvider: config.aiProvider,
    primaryModel,
    lastUsedModel: lastUsedModel || primaryModel,
    lastAIStatus,
  };
}

/**
 * Check if a model is part of the Gemini family.
 */
export function isGeminiModel(model: string): boolean {
  return model.toLowerCase().startsWith('gemini');
}

/**
 * Create OpenAI client instance.
 * Reads directly from VPSMURAH_AI_API_KEY to ensure fresh evaluation without stale cache.
 */
export function getOpenAIClient(): OpenAI {
  if (testOpenAIClient) {
    return testOpenAIClient;
  }

  const apiKey = getVpsmurahAiApiKey();
  const baseURL = (
    process.env.VPSMURAH_AI_BASE_URL ||
    config.vpsmurahAiBaseUrl ||
    'https://my.vpsmurah.co.id/api/v1'
  ).trim();

  return new OpenAI({
    apiKey: apiKey || 'no-key-provided',
    baseURL: baseURL,
    timeout: config.aiModelTimeoutMs,
    maxRetries: 0, // Instant failover without internal SDK retries
  });
}

/**
 * Format conversation history into OpenAI-compatible chat messages.
 * Maps roles:
 * - model -> assistant
 * - assistant -> assistant
 * - user -> user
 * Inserts system instruction if provided.
 */
export function formatOpenAIHistory(
  history: ConversationEntry[],
  currentPrompt: string,
  systemPrompt?: string,
  maxPairs = config.maxHistoryMessages
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  // 1. System Prompt
  if (systemPrompt && systemPrompt.trim()) {
    messages.push({
      role: 'system',
      content: systemPrompt.trim(),
    });
  }

  // 2. Previous History
  if (history && Array.isArray(history) && history.length > 0) {
    const rawTurns: OpenAIMessage[] = [];
    for (const entry of history) {
      if (!entry) continue;

      const rawRole = (entry.role || '').toLowerCase().trim();
      let role: 'user' | 'assistant' | null = null;
      if (rawRole === 'user') {
        role = 'user';
      } else if (rawRole === 'assistant' || rawRole === 'model' || rawRole === 'bot' || rawRole === 'ai') {
        role = 'assistant';
      }

      if (!role) continue;

      const rawText = (typeof entry.content === 'string' ? entry.content : (entry as any).text) || '';
      const text = rawText.trim();
      if (!text) continue;

      rawTurns.push({ role, content: text });
    }

    const maxTurns = maxPairs * 2;
    const sliced = rawTurns.length > maxTurns ? rawTurns.slice(-maxTurns) : rawTurns;
    messages.push(...sliced);
  }

  // 3. Current User Message
  messages.push({
    role: 'user',
    content: currentPrompt,
  });

  return messages;
}

/**
 * Call VPSMurah AI Service with multi-model automatic failover.
 */
export async function generateReplyWithFailover(params: GenerateReplyParams): Promise<string> {
  const { message, senderName, history } = params;

  // Truncate input to max chars
  const truncatedMessage = message.substring(0, config.maxInputChars);
  let currentPrompt = truncatedMessage;
  if (senderName) {
    currentPrompt = `[${senderName}]: ${truncatedMessage}`;
  }

  // Format messages for OpenAI API
  const messages = formatOpenAIHistory(
    history,
    currentPrompt,
    config.systemPrompt,
    config.maxHistoryMessages
  );

  const modelChain =
    config.aiModelChain && config.aiModelChain.length > 0
      ? config.aiModelChain
      : ['gemini-38', 'gemini-37', 'gemini-36', 'gemini-35', 'qwen3-flash', 'gpt-5-mini', 'gpt-4o-mini', 'mistral-small'];

  let switchedToSecondary = false;

  for (let i = 0; i < modelChain.length; i++) {
    const model = modelChain[i];
    const nextModel = i + 1 < modelChain.length ? modelChain[i + 1] : null;

    logger.ai.info(`request model=${model}`);

    try {
      const client = getOpenAIClient();
      const completion = await client.chat.completions.create({
        model,
        messages,
      });

      // Response validation
      const choice = completion.choices && completion.choices[0];
      const content = choice?.message?.content;

      if (!content || !content.trim()) {
        logger.ai.warn(`model=${model} failed status=empty_response`);
        throw new Error(`Empty response content from model ${model}`);
      }

      // Success!
      const reply = content.trim();
      logger.ai.info(`model=${model} success`);
      logger.ai.info('reply generated');

      lastUsedModel = model;
      lastAIStatus = 'success';
      return reply;
    } catch (err: any) {
      const status = err.status || err.statusCode || err.response?.status || 'error';
      const rawMsg = err.message || String(err);
      const sanitizedMsg = rawMsg
        .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [REDACTED]')
        .replace(/key=[^&\s]+/g, 'key=[REDACTED]');

      logger.ai.warn(`model=${model} failed status=${status}`);

      // Non-retryable error check (401 invalid key, 403 forbidden, invalid config)
      if (status === 401 || status === 403 || err.code === 'ERR_INVALID_URL') {
        logger.ai.error(`configuration/provider error status=${status} message=${sanitizedMsg}`);
        lastAIStatus = 'failed';
        throw err;
      }

      // If there is a next model to try:
      if (nextModel) {
        // Log notice when all Gemini models have failed and we are about to try non-Gemini
        if (!switchedToSecondary && isGeminiModel(model) && !isGeminiModel(nextModel)) {
          logger.ai.warn('Gemini models unavailable, switching to secondary provider model');
          switchedToSecondary = true;
        }

        logger.ai.info(`switching model=${nextModel}`);
      }
    }
  }

  // If all models in the chain failed
  lastAIStatus = 'failed';
  throw new Error('All AI models failed in failover chain');
}

/**
 * Generate a reply using the configured AI provider.
 * Defaults to VPSMurah AI multi-model failover engine.
 * Can be switched to Google Gemini direct SDK via AI_PROVIDER=gemini.
 */
export async function generateReply(params: GenerateReplyParams): Promise<string> {
  return generateReplyWithFailover(params);
}
