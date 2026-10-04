/**
 * WhatsApp message sending service.
 * Sends messages via VPSMurah Unofficial API.
 * Endpoint: POST /wa-api/messages
 * Payload: { "to": "...", "text": "..." }
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { formatRecipient } from '../utils/phone';

interface SendResult {
  success: boolean;
  error?: string;
}

/**
 * Send a text message to a WhatsApp recipient via VPSMurah API.
 */
export async function sendMessage(chatId: string, text: string): Promise<SendResult> {
  const recipient = formatRecipient(chatId);

  if (!recipient || !text) {
    logger.whatsapp.warn('sendMessage called with empty recipient or text');
    return { success: false, error: 'Missing recipient or text' };
  }

  // Truncate overly long responses
  const maxResponseChars = 4096;
  const truncatedText = text.length > maxResponseChars
    ? text.substring(0, maxResponseChars) + '\n\n_(pesan terpotong karena terlalu panjang)_'
    : text;

  // VPSMurah POST /wa-api/messages requires ONLY "to" and "text"
  const payload = {
    to: recipient,
    text: truncatedText,
  };

  const controller = new AbortController();
  const timeoutMs = 25_000; // 25 seconds timeout (15-30s range)
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger.whatsapp.info(`Sending message to ${recipient.substring(0, 8)}...`);

    const response = await fetch(config.vpsmurahSendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.vpsmurahApiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      logger.whatsapp.error(`Send failed: status=${status}`);

      let errorMessage: string;
      if (status === 400) {
        errorMessage = `Bad request: status=400 (invalid payload or recipient format)`;
      } else if (status === 401) {
        errorMessage = `Unauthorized: status=401 (invalid or missing API key)`;
      } else if (status === 403) {
        errorMessage = `Forbidden: status=403 (access denied)`;
      } else if (status === 404) {
        errorMessage = `Not found: status=404 (invalid API endpoint)`;
      } else if (status === 429) {
        errorMessage = `Rate limit: status=429 (provider rate limit reached)`;
      } else if (status >= 500) {
        errorMessage = `Provider error: status=${status}`;
      } else {
        errorMessage = `Send failed: status=${status}`;
      }

      return { success: false, error: errorMessage };
    }

    logger.whatsapp.info(`Message sent successfully to ${recipient.substring(0, 8)}...`);
    return { success: true };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.whatsapp.error('Send failed: request timed out');
      return { success: false, error: 'Request timed out' };
    }

    const rawError = (err as Error).message || 'Unknown network error';
    const sanitizedError = config.vpsmurahApiKey
      ? rawError.replaceAll(config.vpsmurahApiKey, '[REDACTED]')
      : rawError;

    logger.whatsapp.error(`Send failed: ${sanitizedError}`);
    return { success: false, error: sanitizedError };
  } finally {
    clearTimeout(timeout);
  }
}
