/**
 * Centralized configuration loaded from environment variables.
 * Validates required variables at startup.
 */

import dotenv from 'dotenv';

dotenv.config({ override: true });

import path from 'path';

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

  // Google Gemini AI (Required: from Google AI Studio)
  geminiApiKey: required('GEMINI_API_KEY', 'Must be obtained from Google AI Studio'),
  geminiModel: optional('GEMINI_MODEL', 'gemini-3.7-flash'),
  systemPrompt: optional('SYSTEM_PROMPT', '') || DEFAULT_SYSTEM_PROMPT,

  // Behavior
  respondInPrivate: optionalBool('RESPOND_IN_PRIVATE', true),
  maxInputChars: optionalInt('MAX_INPUT_CHARS', 8000),
  maxHistoryMessages: optionalInt('MAX_HISTORY_MESSAGES', 10),
  rateLimitPerMinute: optionalInt('RATE_LIMIT_PER_MINUTE', 10),

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
