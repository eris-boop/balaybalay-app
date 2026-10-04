/**
 * Unified AI Service with Smart Model Routing, Multi-Model Failover,
 * Lightweight Circuit Breaker, and History-Free Recovery.
 * Supports VPSMurah OpenAI-compatible API and Google Gemini direct SDK.
 */

import OpenAI from 'openai';
import { config, getVpsmurahAiApiKey } from '../config';
import { ConversationEntry } from '../types/whatsapp';
import { logger } from '../utils/logger';

export type TaskType = 'general' | 'coding' | 'reasoning' | 'longform';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateReplyParams {
  message: string;
  senderName?: string;
  chatId: string;
  history: ConversationEntry[];
  summary?: string | null;
  relevantOldMessages?: ConversationEntry[];
}

// Diagnostics state
let lastTaskType: TaskType = 'general';
let lastUsedModel = '';
let lastAIDurationMs = 0;
let lastFallbackCount = 0;
let lastAIStatus: 'success' | 'failed' | 'idle' = 'idle';

// Allow overriding OpenAI client for testing
let testOpenAIClient: OpenAI | null = null;

export function setTestOpenAIClient(client: OpenAI | null): void {
  testOpenAIClient = client;
}

// -------------------------------------------------------------
// Circuit Breaker State (Per-Model)
// -------------------------------------------------------------
interface CircuitBreakerState {
  consecutiveFailures: number;
  unhealthyUntil: number; // timestamp ms
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

export function isModelHealthy(model: string): boolean {
  const state = circuitBreakers.get(model);
  if (!state) return true;
  return state.unhealthyUntil <= Date.now();
}

export function recordModelSuccess(model: string): void {
  circuitBreakers.delete(model);
}

export function recordModelFailure(model: string, status?: number | string): void {
  const isTransient =
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 408 ||
    status === 'timeout' ||
    status === 'ETIMEDOUT' ||
    status === 'ECONNRESET';

  if (!isTransient) return;

  const current = circuitBreakers.get(model) || {
    consecutiveFailures: 0,
    unhealthyUntil: 0,
  };

  current.consecutiveFailures += 1;
  const threshold = config.circuitBreakerFailures || 3;
  const cooldownMs = config.circuitBreakerCooldownMs || 30000;

  if (current.consecutiveFailures >= threshold) {
    current.unhealthyUntil = Date.now() + cooldownMs;
    logger.ai.warn(
      `model=${model} circuit breaker tripped (${current.consecutiveFailures} failures), cooldown=${cooldownMs}ms`
    );
  }

  circuitBreakers.set(model, current);
}

export function resetCircuitBreakers(): void {
  circuitBreakers.clear();
}

export function resetAIState(): void {
  lastTaskType = 'general';
  lastUsedModel = '';
  lastAIDurationMs = 0;
  lastFallbackCount = 0;
  lastAIStatus = 'idle';
  testOpenAIClient = null;
  resetCircuitBreakers();
}

export function getAIDiagnostics(): {
  aiProvider: string;
  primaryModel: string;
  lastTaskType: string;
  lastUsedModel: string;
  lastAIDurationMs: number;
  lastFallbackCount: number;
  lastAIStatus: string;
} {
  const primaryModel =
    config.aiProvider === 'vpsmurah'
      ? config.aiGeneralChain[0] || config.aiModelChain[0] || 'gemini-38'
      : config.geminiModel;

  return {
    aiProvider: config.aiProvider,
    primaryModel,
    lastTaskType,
    lastUsedModel: lastUsedModel || primaryModel,
    lastAIDurationMs,
    lastFallbackCount,
    lastAIStatus,
  };
}

export function getLastAIResult(): { modelUsed: string; taskType: string } {
  return {
    modelUsed: lastUsedModel || (config.aiProvider === 'gemini' ? config.geminiModel : 'gemini-38'),
    taskType: lastTaskType || 'general',
  };
}

/**
 * Filter out fallback/error messages from conversation history.
 */
const FALLBACK_PHRASES = [
  'ai sedang mengalami gangguan sementara',
  'ai sedang ramai sebentar',
  'maaf, saya lagi mengalami gangguan',
  'internal error',
  'coba lagi beberapa saat ya',
];

export function isFallbackOrErrorText(text: string): boolean {
  if (!text) return true;
  const lower = text.toLowerCase();
  return FALLBACK_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Validates and sanitizes conversation history before sending to AI:
 * - Maps valid roles (user, assistant)
 * - Removes empty/whitespace entries
 * - Removes fallback and error messages
 * - Removes duplicate adjacent entries
 * - Trims to maxPairs
 */
export function sanitizeHistory(
  history: ConversationEntry[],
  maxPairs = config.maxHistoryMessages
): ConversationEntry[] {
  if (!history || !Array.isArray(history) || history.length === 0) {
    return [];
  }

  const cleanEntries: ConversationEntry[] = [];
  let lastRole: string | null = null;
  let lastContent: string | null = null;

  for (const entry of history) {
    if (!entry) continue;

    const rawRole = (entry.role || '').toLowerCase().trim();
    let role: 'user' | 'assistant' | null = null;
    if (rawRole === 'user') {
      role = 'user';
    } else if (
      rawRole === 'assistant' ||
      rawRole === 'model' ||
      rawRole === 'bot' ||
      rawRole === 'ai'
    ) {
      role = 'assistant';
    }

    if (!role) continue;

    const rawText = (typeof entry.content === 'string' ? entry.content : (entry as any).text) || '';
    const content = rawText.trim();
    if (!content) continue;

    // Filter out fallback / error messages
    if (isFallbackOrErrorText(content)) {
      continue;
    }

    // Filter out duplicated adjacent item (same role and identical content)
    if (role === lastRole && content === lastContent) {
      continue;
    }

    lastRole = role;
    lastContent = content;

    cleanEntries.push({
      role,
      content,
      timestamp: entry.timestamp || Date.now(),
    });
  }

  const maxTurns = maxPairs * 2;
  return cleanEntries.length > maxTurns ? cleanEntries.slice(-maxTurns) : cleanEntries;
}

/**
 * Lightweight local heuristic classifier to route prompts to optimal model chains.
 * Zero external AI calls for speed and zero added latency.
 */
export function detectTaskType(text: string): TaskType {
  if (!text || typeof text !== 'string') {
    return 'general';
  }

  const normalized = text.toLowerCase().trim();

  // 1. Longform Heuristic (essays, reports, proposals, comprehensive analysis, word counts)
  const longformPatterns = [
    /\b(buat|tulis|bikin)?\s*essay\b/i,
    /\b(buat|tulis|bikin)?\s*esai\b/i,
    /\bjelaskan\s+lengkap\b/i,
    /\banalisis\s+panjang\b/i,
    /\b(buat|tulis|bikin)?\s*laporan\b/i,
    /\b(buat|tulis|bikin)?\s*proposal\b/i,
    /\brangkum\s+lengkap\b/i,
    /\b(makalah|skripsi|tesis)\b/i,
    /\b\d+\s*kata\b/i,
    /\bessay\s+panjang\b/i,
    /\b(panjang\s+lebar|secara\s+komprehensif|mendalam\s+dan\s+lengkap)\b/i,
  ];

  for (const pattern of longformPatterns) {
    if (pattern.test(normalized)) {
      return 'longform';
    }
  }

  // 2. Coding Heuristic (code, programming languages, functions, classes, debug, web development, calculator, scripts)
  const codingPatterns = [
    /```[\s\S]*?```/,
    /\b(kalkulator|calculator)\b/i,
    /\b(python|javascript|typescript|js|ts|java|c\+\+|cpp|golang|go|rust|php|ruby|swift|kotlin|csharp|c#|html|css|sql|bash|sh|powershell)\b/i,
    /\b(code|kode|coding|koding|programmer|program|pemrograman|script|skrip|source\s*code)\b/i,
    /\b(debug|debugging|error|exception|stacktrace|syntax|bug|refactor|compile|compiler)\b/i,
    /\b(function|fungsi|method|metode|class|kelas|variable|variabel|regex|regexp|array|loop|looping|perulangan)\b/i,
    /\b(api|endpoint|rest\s*api|graphql|backend|frontend|fullstack|website|web\s*app|framework|library)\b/i,
    /\b(git|github|gitlab|docker|dockerfile|kubernetes|npm|yarn|pnpm|pip)\b/i,
    /\b(react|vue|angular|svelte|nextjs|express|django|flask|laravel|spring|fastapi)\b/i,
    /\b(database|query|select\s+\*|insert\s+into|join|mongodb|postgresql|postgres|mysql|sqlite|redis)\b/i,
    /\b(buat|buatkan|bikin|tulis|tuliskan|create|build|make)\s+.*?\b(program|aplikasi|app|bot|game|fitur|feature|web|website|skrip|script|fungsi|function|kalkulator|calculator)\b/i,
  ];

  for (const pattern of codingPatterns) {
    if (pattern.test(normalized)) {
      return 'coding';
    }
  }

  // 3. Reasoning Heuristic (math, logic, algorithm, complex problems, calculations, probability)
  const reasoningPatterns = [
    /\b(matematika|math)\b/i,
    /\b(logika|logic)\b/i,
    /\b(analisis|analisa|analyze|analysis)\b/i,
    /\b(algoritma|algorithm)\b/i,
    /\b(soal\s+kompleks|problem\s+solving)\b/i,
    /\b(reasoning|penalaran|deduksi|induksi)\b/i,
    /\b(probabilitas|peluang|probability)\b/i,
    /\b(hitung|kalkulasi|calculate|rumus|persamaan|aljabar|integral|turunan|geometri|trigonometri)\b/i,
    /\b(teka-teki|riddle|puzzle)\b/i,
    /\b(pecahkan|buktikan|hipotesis)\b/i,
    /\d+\s*[\+\-\*\/\^]\s*\d+/,
  ];

  for (const pattern of reasoningPatterns) {
    if (pattern.test(normalized)) {
      return 'reasoning';
    }
  }

  // 4. Default to General Chat
  return 'general';
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
  maxPairs = config.maxHistoryMessages,
  summary?: string | null,
  relevantOldMessages?: ConversationEntry[]
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  // 1. System Prompt + Long-Term Memory Summary
  let effectiveSystemPrompt = (systemPrompt || config.systemPrompt || '').trim();
  if (summary && summary.trim()) {
    effectiveSystemPrompt += `\n\n[MEMORI JANGKA PANJANG]\n${summary.trim()}`;
  }

  if (effectiveSystemPrompt) {
    messages.push({
      role: 'system',
      content: effectiveSystemPrompt,
    });
  }

  // 2. Relevant Old Messages (from Full-Text Search, if any)
  if (relevantOldMessages && relevantOldMessages.length > 0) {
    const cleanRelevant = sanitizeHistory(relevantOldMessages, config.memoryRetrievalLimit);
    for (const entry of cleanRelevant) {
      messages.push({
        role: entry.role,
        content: `[Konteks chat lama relevan] ${entry.content}`,
      });
    }
  }

  // 3. Previous History (Cleaned & Validated)
  const cleanHistory = sanitizeHistory(history, maxPairs);
  for (const entry of cleanHistory) {
    messages.push({
      role: entry.role,
      content: entry.content,
    });
  }

  // 4. Current User Message
  messages.push({
    role: 'user',
    content: currentPrompt,
  });

  return messages;
}

/**
 * Get active model chains based on detected task type.
 */
export function getModelChainsForTask(taskType: TaskType): {
  categoryChain: string[];
  emergencyChain: string[];
} {
  let categoryChain: string[];

  switch (taskType) {
    case 'coding':
      categoryChain =
        config.aiCodingChain.length > 0
          ? config.aiCodingChain
          : ['qwen3-coder', 'gemini-38', 'gpt-53-codex', 'deepseek-coder', 'codestral', 'gpt-5-mini'];
      break;
    case 'reasoning':
      categoryChain =
        config.aiReasoningChain.length > 0
          ? config.aiReasoningChain
          : ['gemini-38', 'gemini-37', 'qwen3-plus', 'deepseek-r1', 'kimi-k3', 'gpt-55'];
      break;
    case 'longform':
      categoryChain =
        config.aiLongformChain.length > 0
          ? config.aiLongformChain
          : ['gemini-38', 'gemini-37', 'qwen3-max', 'gpt-55', 'llama-4-maverick'];
      break;
    case 'general':
    default:
      categoryChain =
        config.aiGeneralChain.length > 0
          ? config.aiGeneralChain
          : ['gemini-38', 'qwen3-flash', 'gemini-37', 'gemini-36', 'gpt-5-mini', 'gpt-4o-mini', 'mistral-small'];
      break;
  }

  const emergencyChain =
    config.aiEmergencyChain.length > 0
      ? config.aiEmergencyChain
      : ['qwen3-flash', 'gpt-5-mini', 'llama-4-scout', 'mistral-small'];

  return { categoryChain, emergencyChain };
}

/**
 * Call VPSMurah AI Service with smart task routing, multi-model automatic failover,
 * lightweight circuit breaker, and history-free recovery.
 */
export async function generateReplyWithFailover(params: GenerateReplyParams): Promise<string> {
  const { message, senderName, history } = params;

  // 1. Smart routing (local heuristic)
  const taskType = detectTaskType(message);
  logger.ai.info(`task=${taskType}`);

  // Truncate input to max chars
  const truncatedMessage = message.substring(0, config.maxInputChars);
  let currentPrompt = truncatedMessage;
  if (senderName) {
    currentPrompt = `[${senderName}]: ${truncatedMessage}`;
  }

  // Format messages for OpenAI API (Sanitizes history before request)
  const cleanHistory = sanitizeHistory(history, config.maxHistoryMessages);
  const messages = formatOpenAIHistory(
    cleanHistory,
    currentPrompt,
    config.systemPrompt,
    config.maxHistoryMessages,
    params.summary,
    params.relevantOldMessages
  );

  const { categoryChain, emergencyChain } = getModelChainsForTask(taskType);

  // Build failover candidate list: category models first, then unattempted emergency models
  const plannedModels: { model: string; isEmergency: boolean }[] = [];
  for (const m of categoryChain) {
    plannedModels.push({ model: m, isEmergency: false });
  }
  for (const m of emergencyChain) {
    if (!categoryChain.includes(m)) {
      plannedModels.push({ model: m, isEmergency: true });
    }
  }

  // Check circuit breaker status: prioritize healthy models, or try all if none are healthy
  const healthyPlanned = plannedModels.filter(({ model }) => isModelHealthy(model));
  const modelsToAttempt = healthyPlanned.length > 0 ? healthyPlanned : plannedModels;

  const overallStartTime = Date.now();
  const totalTimeoutMs = config.aiTotalTimeoutMs || 25000;
  let fallbackCount = 0;
  let switchedToEmergency = false;
  const attemptedModels: string[] = [];

  for (let i = 0; i < modelsToAttempt.length; i++) {
    const { model, isEmergency } = modelsToAttempt[i];
    const next = i + 1 < modelsToAttempt.length ? modelsToAttempt[i + 1] : null;

    // Check overall total timeout constraint
    const elapsedTotal = Date.now() - overallStartTime;
    const remainingTotalMs = totalTimeoutMs - elapsedTotal;
    if (remainingTotalMs <= 0) {
      logger.ai.warn(`total timeout reached (${totalTimeoutMs}ms), aborting model failover`);
      break;
    }

    if (isEmergency && !switchedToEmergency) {
      logger.ai.warn('Category chain exhausted, switching to emergency fallback chain');
      switchedToEmergency = true;
    }

    const perModelTimeout = Math.min(config.aiModelTimeoutMs || 7000, remainingTotalMs);
    const modelStartTime = Date.now();
    attemptedModels.push(model);
    logger.ai.info(`model=${model} start`);

    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;

    try {
      const client = getOpenAIClient();

      // Enforce per-model timeout with AbortController and Promise.race
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr: any = new Error(`Model ${model} timed out after ${perModelTimeout}ms`);
          timeoutErr.status = 408;
          timeoutErr.statusCode = 408;
          timeoutErr.code = 'ETIMEDOUT';
          controller.abort();
          reject(timeoutErr);
        }, perModelTimeout);
        if (typeof timer.unref === 'function') timer.unref();
      });

      let completion: any;
      try {
        completion = await Promise.race([
          client.chat.completions.create(
            { model, messages },
            { signal: controller.signal, timeout: perModelTimeout }
          ),
          timeoutPromise,
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }

      // Response validation
      const choice = completion?.choices && completion.choices[0];
      const content = choice?.message?.content;

      if (!content || !content.trim()) {
        logger.ai.warn(`model=${model} failed status=empty_response`);
        throw new Error(`Empty response content from model ${model}`);
      }

      // Success!
      const modelDurationMs = Date.now() - modelStartTime;
      const totalDurationMs = Date.now() - overallStartTime;
      logger.ai.info(`model=${model} success duration=${modelDurationMs}ms`);
      logger.ai.info('reply generated');

      recordModelSuccess(model);
      lastTaskType = taskType;
      lastUsedModel = model;
      lastAIDurationMs = totalDurationMs;
      lastFallbackCount = fallbackCount;
      lastAIStatus = 'success';

      logger.ai.info(
        `[ai] taskType=${taskType} attemptedModels=${attemptedModels.join(',')} modelUsed=${model} modelDurationMs=${modelDurationMs} totalDurationMs=${totalDurationMs} fallbackCount=${fallbackCount} finalStatus=success`
      );

      return content.trim();
    } catch (err: any) {
      fallbackCount++;
      const status =
        err.status ||
        err.statusCode ||
        (err.name === 'AbortError' || err.message?.includes('timed out') ? 408 : 'error');

      recordModelFailure(model, status);

      const rawMsg = err.message || String(err);
      const sanitizedMsg = rawMsg
        .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [REDACTED]')
        .replace(/key=[^&\s]+/g, 'key=[REDACTED]');

      logger.ai.warn(`model=${model} failed status=${status}`);

      // Permanent request-validation errors (401 invalid key, 403 forbidden, invalid config)
      if (status === 401 || status === 403 || err.code === 'ERR_INVALID_URL') {
        logger.ai.error(`configuration/provider error status=${status} message=${sanitizedMsg}`);
        lastTaskType = taskType;
        lastAIDurationMs = Date.now() - overallStartTime;
        lastFallbackCount = fallbackCount;
        lastAIStatus = 'failed';
        logger.ai.info(
          `[ai] taskType=${taskType} attemptedModels=${attemptedModels.join(',')} modelUsed=none modelDurationMs=${Date.now() - modelStartTime} totalDurationMs=${Date.now() - overallStartTime} fallbackCount=${fallbackCount} finalStatus=failed`
        );
        throw err;
      }

      // If there is a next model to try in chain
      if (next) {
        logger.ai.info(`switching model=${next.model}`);
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  }

  // -------------------------------------------------------------
  // HISTORY RECOVERY ATTEMPT
  // If all models in the normal chain failed and history was present,
  // history might be corrupt/policy-poisoned. Try 1 attempt without history!
  // -------------------------------------------------------------
  const remainingTotalMs = totalTimeoutMs - (Date.now() - overallStartTime);
  if (cleanHistory.length > 0 && remainingTotalMs > 500) {
    logger.ai.warn('primary chain failed');
    logger.ai.info('retrying without history');

    const recoveryCandidates = ['gemini-38', 'gemini-37', 'qwen3-flash'];
    const recoveryModel =
      recoveryCandidates.find((m) => isModelHealthy(m)) || recoveryCandidates[0];

    const recoveryMessages = formatOpenAIHistory(
      [], // Empty history!
      currentPrompt,
      config.systemPrompt,
      config.maxHistoryMessages
    );

    const recoveryTimeout = Math.min(config.aiModelTimeoutMs || 7000, remainingTotalMs);
    const recoveryStart = Date.now();
    attemptedModels.push(recoveryModel);
    logger.ai.info(`model=${recoveryModel} start (recovery attempt)`);

    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;

    try {
      const client = getOpenAIClient();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr: any = new Error(
            `Recovery model ${recoveryModel} timed out after ${recoveryTimeout}ms`
          );
          timeoutErr.status = 408;
          controller.abort();
          reject(timeoutErr);
        }, recoveryTimeout);
        if (typeof timer.unref === 'function') timer.unref();
      });

      let completion: any;
      try {
        completion = await Promise.race([
          client.chat.completions.create(
            { model: recoveryModel, messages: recoveryMessages },
            { signal: controller.signal, timeout: recoveryTimeout }
          ),
          timeoutPromise,
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }

      const choice = completion?.choices && completion.choices[0];
      const content = choice?.message?.content;
      if (content && content.trim()) {
        const reply = content.trim();
        const duration = Date.now() - recoveryStart;
        const totalDurationMs = Date.now() - overallStartTime;
        logger.ai.info('history-free recovery success');
        logger.ai.info(`model=${recoveryModel} success duration=${duration}ms`);
        logger.ai.info('reply generated');

        recordModelSuccess(recoveryModel);
        lastTaskType = taskType;
        lastUsedModel = recoveryModel;
        lastAIDurationMs = totalDurationMs;
        lastFallbackCount = fallbackCount + 1;
        lastAIStatus = 'success';

        logger.ai.info(
          `[ai] taskType=${taskType} attemptedModels=${attemptedModels.join(',')} modelUsed=${recoveryModel} modelDurationMs=${duration} totalDurationMs=${totalDurationMs} fallbackCount=${fallbackCount + 1} finalStatus=success`
        );

        return reply;
      }
    } catch (err: any) {
      logger.ai.warn('history-free recovery failed');
      recordModelFailure(recoveryModel, err.status || err.statusCode || 500);
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  }

  // If all models in the chain failed or total timeout expired
  lastTaskType = taskType;
  lastAIDurationMs = Date.now() - overallStartTime;
  lastFallbackCount = fallbackCount;
  lastAIStatus = 'failed';
  logger.ai.info(
    `[ai] taskType=${taskType} attemptedModels=${attemptedModels.join(',')} modelUsed=none modelDurationMs=0 totalDurationMs=${Date.now() - overallStartTime} fallbackCount=${fallbackCount} finalStatus=failed`
  );
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
