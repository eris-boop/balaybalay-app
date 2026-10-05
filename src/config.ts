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

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah BalayBalay AI, asisten WhatsApp serbaguna yang cerdas, natural, akurat, dan dapat diandalkan.
- Berikan respon dalam bahasa Indonesia jika pengguna menggunakan bahasa Indonesia. Pahami bahasa gaul, singkatan sehari-hari, dan typo secara wajar.
- Jawab langsung ke inti pertanyaan tanpa bertele-tele dan hindari pengulangan kalimat penutup klise seperti "Ada yang bisa saya bantu?".
- Pertahankan kesinambungan alur percakapan serta manfaatkan konteks pesan yang dikutip (quoted message) dan riwayat sebelumnya.
- Untuk pertanyaan sederhana atau santai, berikan jawaban yang ringkas dan padat. Untuk pertanyaan kompleks, analisis, matematika, dan penalaran, berikan penjelasan mendalam dan terstruktur.
- Untuk permintaan pemrograman/coding, berikan kode program yang fungsional, bersih, lengkap, dan siap dijalankan.
- Tangani pertanyaan agama edukatif secara informatif, objektif, dan proporsional.
- Tangani pertanyaan kesehatan dan biologis secara informatif dan edukatif.
- Bahas tokoh publik dan politik secara netral, faktual, dan berimbang.
- Gunakan memori jangka panjang dan fakta yang tersimpan di database jika relevan. Jangan berhalusinasi tentang memori yang tidak ada.
- Bedakan antara fakta terverifikasi dan klaim yang diucapkan pengguna dalam obrolan chat sebelumnya. Sampaikan informasi dari obrolan dengan atribusi yang tepat (misalnya: "Sebelumnya dalam percakapan sempat disebutkan bahwa..."). Jika terdapat kontradiksi atau ketidakpastian, sampaikan secara jujur.
- Gunakan format teks WhatsApp (*tebal*, _miring_, poin-poin) agar nyaman dibaca.`;

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
  'gemini-38,qwen3-flash,gpt-5-mini,gemini-37,gpt-4o-mini,mistral-small';

const DEFAULT_GENERAL_CHAIN =
  'gemini-38,qwen3-flash,gpt-5-mini,gemini-37,gpt-4o-mini,mistral-small';
const DEFAULT_CODING_CHAIN =
  'qwen3-coder,gemini-38,gpt-53-codex,deepseek-coder,codestral,gpt-5-mini';
const DEFAULT_REASONING_CHAIN =
  'gemini-38,qwen3-plus,gpt-5-mini,gemini-37,deepseek-r1,kimi-k3,gpt-55';
const DEFAULT_LONGFORM_CHAIN =
  'gemini-38,gemini-37,qwen3-max,gpt-55,llama-4-maverick';
const DEFAULT_EMERGENCY_CHAIN =
  'qwen3-flash,gpt-5-mini,gpt-4o-mini,mistral-small';

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

  // Group Triggers & Archiving Policy
  groupReplyOnMention: optionalBool('GROUP_REPLY_ON_MENTION', true),
  groupReplyOnQuote: optionalBool('GROUP_REPLY_ON_QUOTE', true),
  groupReplyAlways: optionalBool('GROUP_REPLY_ALWAYS', false),
  groupArchiveAllText: optionalBool('GROUP_ARCHIVE_ALL_TEXT', true),
  groupStoreProcessedMessages: optionalBool('GROUP_STORE_PROCESSED_MESSAGES', true),

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

  // Category-specific Timeouts & Queue Deadlines
  aiGeneralTimeoutMs: optionalInt('AI_GENERAL_TIMEOUT_MS', 90000),
  aiCodingTimeoutMs: optionalInt('AI_CODING_TIMEOUT_MS', 180000),
  aiReasoningTimeoutMs: optionalInt('AI_REASONING_TIMEOUT_MS', 240000),
  aiLongformTimeoutMs: optionalInt('AI_LONGFORM_TIMEOUT_MS', 360000),
  directGeminiTimeoutMs: optionalInt('DIRECT_GEMINI_TIMEOUT_MS', 180000),
  aiTotalTimeoutMs: optionalInt('AI_TOTAL_TIMEOUT_MS', 600000),
  chatJobTimeoutMs: optionalInt('CHAT_JOB_TIMEOUT_MS', 660000),
  aiModelTimeoutMs: optionalInt('AI_MODEL_TIMEOUT_MS', 90000), // backward compatibility

  aiDirectGeminiFallback: optionalBool('AI_DIRECT_GEMINI_FALLBACK', true),
  circuitBreakerFailures: optionalInt('CIRCUIT_BREAKER_FAILURES', 3),
  circuitBreakerCooldownMs: optionalInt('CIRCUIT_BREAKER_COOLDOWN_MS', 30000),

  // Google Gemini AI (Direct SDK fallback)
  geminiApiKey: optional('GEMINI_API_KEY', ''),
  geminiModel: optional('GEMINI_MODEL', 'gemini-3.7-flash'),
  geminiFallbackModel: optional('GEMINI_FALLBACK_MODEL', ''),
  systemPrompt: optional('SYSTEM_PROMPT', '') || DEFAULT_SYSTEM_PROMPT,

  // Behavior
  respondInPrivate: optionalBool('RESPOND_IN_PRIVATE', true),
  maxInputChars: optionalInt('MAX_INPUT_CHARS', 8000),
  maxHistoryMessages: optionalInt('MAX_HISTORY_MESSAGES', 30),

  // PostgreSQL Persistent Memory & Pool Resilience
  databaseUrl: optional('DATABASE_URL', ''),
  dbPoolMax: optionalInt('DB_POOL_MAX', 10),
  dbConnectionTimeoutMs: optionalInt('DB_CONNECTION_TIMEOUT_MS', 10000),
  dbIdleTimeoutMs: optionalInt('DB_IDLE_TIMEOUT_MS', 30000),
  dbQueryTimeoutMs: optionalInt('DB_QUERY_TIMEOUT_MS', 15000),

  // Persistent DB Outage Spool
  dbSpoolEnabled: optionalBool('DB_SPOOL_ENABLED', true),
  dbSpoolPath: optional('DB_SPOOL_PATH', process.platform === 'win32'
    ? path.resolve(process.cwd(), 'data/db-spool/messages.jsonl')
    : '/app/data/db-spool/messages.jsonl'),

  // Memory Summarization
  memorySummaryEnabled: optionalBool('MEMORY_SUMMARY_ENABLED', true),
  memorySummaryAfterMessages: optionalInt('MEMORY_SUMMARY_AFTER_MESSAGES', 30),
  memorySummaryKeepRecent: optionalInt('MEMORY_SUMMARY_KEEP_RECENT', 20),

  // Context Retrieval Limits
  memoryRetrievalEnabled: optionalBool('MEMORY_RETRIEVAL_ENABLED', true),
  memoryRetrievalLimit: optionalInt('MEMORY_RETRIEVAL_LIMIT', 12),
  globalMemoryRetrievalLimit: optionalInt('GLOBAL_MEMORY_RETRIEVAL_LIMIT', 16),
  memoryFactRetrievalLimit: optionalInt('MEMORY_FACT_RETRIEVAL_LIMIT', 20),
  memoryMaxContextChars: optionalInt('MEMORY_MAX_CONTEXT_CHARS', 30000),

  // Global Memory Scope
  globalMemoryEnabled: optionalBool('GLOBAL_MEMORY_ENABLED', true),
  globalMemoryCrossChat: optionalBool('GLOBAL_MEMORY_CROSS_CHAT', true),
  globalMemoryScope: optional('GLOBAL_MEMORY_SCOPE', 'shared_global'),
  globalMemorySummaryAfterMessages: optionalInt('GLOBAL_MEMORY_SUMMARY_AFTER_MESSAGES', 50),
  globalMemorySummaryKeepRecent: optionalInt('GLOBAL_MEMORY_SUMMARY_KEEP_RECENT', 30),

  // Background Memory Learner
  memoryLearnerEnabled: optionalBool('MEMORY_LEARNER_ENABLED', true),
  memoryLearnerModel: optional('MEMORY_LEARNER_MODEL', 'gemini-38'),
  memoryLearnerFallbackModel: optional('MEMORY_LEARNER_FALLBACK_MODEL', 'qwen3-flash'),
  memoryLearnerIntervalMs: optionalInt('MEMORY_LEARNER_INTERVAL_MS', 5000),
  memoryLearnerBatchSize: optionalInt('MEMORY_LEARNER_BATCH_SIZE', 10),
  memoryLearnerMaxRetries: optionalInt('MEMORY_LEARNER_MAX_RETRIES', 5),
  memoryLearnerConcurrency: optionalInt('MEMORY_LEARNER_CONCURRENCY', 1),

  // Text Knowledge Snapshots
  memoryTextSnapshotEnabled: optionalBool('MEMORY_TEXT_SNAPSHOT_ENABLED', true),
  memoryTextSnapshotPath: optional('MEMORY_TEXT_SNAPSHOT_PATH', process.platform === 'win32'
    ? path.resolve(process.cwd(), 'data/memory/knowledge_snapshot.txt')
    : '/app/data/memory/knowledge_snapshot.txt'),
  memoryNewInfoSnapshotPath: optional('MEMORY_NEW_INFO_SNAPSHOT_PATH', process.platform === 'win32'
    ? path.resolve(process.cwd(), 'data/memory/new_information.txt')
    : '/app/data/memory/new_information.txt'),

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
};
