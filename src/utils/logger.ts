/**
 * Structured logger with prefixed categories.
 * Never logs secrets, API keys, or authorization headers.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const SENSITIVE_KEYS = [
  'apikey', 'api_key', 'authorization', 'token', 'secret', 'password', 'credential',
];

function sanitize(obj: unknown): unknown {
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object' || obj === null) return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitize);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.some((s) => lower.includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitize(value);
    }
  }
  return sanitized;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(sanitize(arg), null, 2);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function createLogger(prefix: string) {
  const log = (level: LogLevel, ...args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const msg = `${timestamp} [${prefix}] [${level.toUpperCase()}] ${formatArgs(args)}`;
    if (level === 'error') {
      console.error(msg);
    } else if (level === 'warn') {
      console.warn(msg);
    } else {
      console.log(msg);
    }
  };

  return {
    info: (...args: unknown[]) => log('info', ...args),
    warn: (...args: unknown[]) => log('warn', ...args),
    error: (...args: unknown[]) => log('error', ...args),
    debug: (...args: unknown[]) => log('debug', ...args),
  };
}

export const logger = {
  webhook: createLogger('WEBHOOK'),
  whatsapp: createLogger('WHATSAPP'),
  gemini: createLogger('GEMINI'),
  error: createLogger('ERROR'),
  server: createLogger('SERVER'),
  polling: createLogger('POLLING'),
};
