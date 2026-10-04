/**
 * Centralized configuration loaded from environment variables.
 * Validates required variables at startup.
 */

import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`[CONFIG] Missing required environment variable: ${key}`);
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

export const config = {
  port: optionalInt('PORT', 3000),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',

  // VPSMurah
  vpsmurahApiKey: required('VPSMURAH_API_KEY'),
  vpsmurahSendUrl: optional(
    'VPSMURAH_WHATSAPP_SEND_URL',
    'https://my.vpsmurah.co.id/api/svc/v1/wa-api/messages'
  ),
  vpsmurahWebhookSecret: process.env.VPSMURAH_WEBHOOK_SECRET || '',

  // Bot identity
  botWhatsappNumber: required('BOT_WHATSAPP_NUMBER'),

  // Gemini
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: optional('GEMINI_MODEL', 'gemini-2.0-flash'),
  systemPrompt: optional('SYSTEM_PROMPT', '') || DEFAULT_SYSTEM_PROMPT,

  // Behavior
  respondInPrivate: optionalBool('RESPOND_IN_PRIVATE', true),
  maxInputChars: optionalInt('MAX_INPUT_CHARS', 8000),
  maxHistoryMessages: optionalInt('MAX_HISTORY_MESSAGES', 10),
  rateLimitPerMinute: optionalInt('RATE_LIMIT_PER_MINUTE', 10),
} as const;
