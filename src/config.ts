/**
 * Centralized configuration loaded from environment variables.
 * Validates required variables at startup.
 */

import dotenv from 'dotenv';
import path from 'path';

// Always resolve .env relative to current working directory explicitly
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });


function required(key: string, hint?: string): string {
  const value = process.env[key];
  if (!value) {
    const hintMsg = hint ? ` (${hint})` : '';
    console.error(`[CONFIG] Missing required environment variable: ${key}${hintMsg}`);
    process.exit(1);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.toLowerCase() === 'true';
}

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah asisten WhatsApp yang membantu, akurat, ringkas, dan natural.
Jawab dengan bahasa yang sama dengan pengguna kecuali pengguna meminta bahasa lain.
Jangan mengatakan bahwa kamu memiliki akses ke data atau fitur yang sebenarnya tidak tersedia.
Gunakan formatting WhatsApp yang sederhana.`;

const defaultAuthDir = process.env.WHATSAPP_AUTH_DIR ||
  (process.platform === 'win32'
    ? path.resolve(process.cwd(), 'data/wa-auth')
    : '/app/data/wa-auth');

export function cleanApiKey(raw?: string | null): string {
  let val = (raw || '').trim();
  if (val.startsWith('Bearer ')) {
    val = val.slice(7).trim();
  }
  return val;
}

export function getVpsmurahAiApiKey(): string {
  if (process.env.VPSMURAH_AI_API_KEY !== undefined && process.env.VPSMURAH_AI_API_KEY !== null) {
    return cleanApiKey(process.env.VPSMURAH_AI_API_KEY);
  }
  return cleanApiKey(config.vpsmurahAiApiKey);
}

function parseModelChain(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

const DEFAULT_MODEL_CHAIN =
  'gemini-38,gemini-37,gemini-36,gemini-35,qwen3-flash,gpt-5-mini,gpt-4o-mini,mistral-small';

const DEFAULT_GENERAL_CHAIN =
  'gemini-38,qwen3-flash,gemini-37,gemini-36,gpt-5-mini,gpt-4o-mini,mistral-small';
const DEFAULT_CODING_CHAIN =
  'qwen3-coder,gemini-38,gpt-53-codex,deepseek-coder,codestral,gpt-5-mini';
const DEFAULT_REASONING_CHAIN =
  'gemini-38,gemini-37,qwen3-plus,deepseek-r1,kimi-k3,gpt-55';
const DEFAULT_LONGFORM_CHAIN =
  'gemini-38,gemini-37,qwen3-max,gpt-55,llama-4-maverick';
const DEFAULT_EMERGENCY_CHAIN =
  'qwen3-flash,gpt-5-mini,llama-4-scout,mistral-small';

export const config = {
  port: optionalInt('PORT', 3000),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',

  // WhatsApp Provider & Baileys Settings
  whatsappProvider: optional('WHATSAPP_PROVIDER', 'baileys').toLowerCase(),
  whatsappAuthDir: defaultAuthDir,
  adminToken: optional('ADMIN_TOKEN', ''),

  // Bot Identity (optional when using Baileys because JID is fetched from socket user)
  botWhatsappNumber: optional('BOT_WHATSAPP_NUMBER', ''),

  // AI Provider & Settings
  aiProvider: optional('AI_PROVIDER', 'vpsmurah').toLowerCase(),
  vpsmurahAiBaseUrl: optional('VPSMURAH_AI_BASE_URL', 'https://my.vpsmurah.co.id/api/v1'),
  vpsmurahAiApiKey: cleanApiKey(optional('VPSMURAH_AI_API_KEY', '')),
  aiModelChain: parseModelChain(optional('AI_MODEL_CHAIN', DEFAULT_MODEL_CHAIN)),
  aiGeneralChain: parseModelChain(optional('AI_GENERAL_CHAIN', DEFAULT_GENERAL_CHAIN)),
  aiCodingChain: parseModelChain(optional('AI_CODING_CHAIN', DEFAULT_CODING_CHAIN)),
  aiReasoningChain: parseModelChain(optional('AI_REASONING_CHAIN', DEFAULT_REASONING_CHAIN)),
  aiLongformChain: parseModelChain(optional('AI_LONGFORM_CHAIN', DEFAULT_LONGFORM_CHAIN)),
  aiEmergencyChain: parseModelChain(optional('AI_EMERGENCY_CHAIN', DEFAULT_EMERGENCY_CHAIN)),
  aiModelTimeoutMs: optionalInt('AI_MODEL_TIMEOUT_MS', 7000),
  aiTotalTimeoutMs: optionalInt('AI_TOTAL_TIMEOUT_MS', 25000),
  aiDirectGeminiFallback: optionalBool('AI_DIRECT_GEMINI_FALLBACK', true),
  circuitBreakerFailures: optionalInt('CIRCUIT_BREAKER_FAILURES', 3),
  circuitBreakerCooldownMs: optionalInt('CIRCUIT_BREAKER_COOLDOWN_MS', 30000),
  chatJobTimeoutMs: optionalInt('CHAT_JOB_TIMEOUT_MS', 30000),

  // Google Gemini AI (Direct SDK fallback)
  geminiApiKey: optional('GEMINI_API_KEY', ''),
  geminiModel: optional('GEMINI_MODEL', 'gemini-3.7-flash'),
  geminiFallbackModel: optional('GEMINI_FALLBACK_MODEL', ''),
  systemPrompt: optional('SYSTEM_PROMPT', '') || DEFAULT_SYSTEM_PROMPT,

  // Behavior
  respondInPrivate: optionalBool('RESPOND_IN_PRIVATE', true),
  maxInputChars: optionalInt('MAX_INPUT_CHARS', 8000),
  maxHistoryMessages: optionalInt('MAX_HISTORY_MESSAGES', 20),

  // PostgreSQL Persistent Memory
  databaseUrl: optional('DATABASE_URL', ''),
  memorySummaryEnabled: optionalBool('MEMORY_SUMMARY_ENABLED', true),
  memorySummaryAfterMessages: optionalInt('MEMORY_SUMMARY_AFTER_MESSAGES', 30),
  memorySummaryKeepRecent: optionalInt('MEMORY_SUMMARY_KEEP_RECENT', 20),
  memoryRetrievalEnabled: optionalBool('MEMORY_RETRIEVAL_ENABLED', true),
  memoryRetrievalLimit: optionalInt('MEMORY_RETRIEVAL_LIMIT', 6),
  memoryMaxContextChars: optionalInt('MEMORY_MAX_CONTEXT_CHARS', 12000),

  // Profanity Filter
  profanityFilterEnabled: optionalBool('PROFANITY_FILTER_ENABLED', true),
  profanityFilterMode: optional('PROFANITY_FILTER_MODE', 'mask'),
  profanityExtraWords: optional('PROFANITY_EXTRA_WORDS', ''),

  // Legacy VPSMurah (optional fallback)
  vpsmurahApiKey: optional('VPSMURAH_API_KEY', ''),
  vpsmurahSendUrl: optional(
    'VPSMURAH_WHATSAPP_SEND_URL',
    'https://my.vpsmurah.co.id/api/svc/v1/wa-api/messages'
  ),
  vpsmurahInboxUrl: optional(
    'VPSMURAH_WHATSAPP_INBOX_URL',
    'https://my.vpsmurah.co.id/api/svc/v1/wa-api/inbox'
  ),
  vpsmurahWebhookSecret: process.env.VPSMURAH_WEBHOOK_SECRET || '',
} as const;
