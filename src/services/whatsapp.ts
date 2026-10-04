/**
 * WhatsApp message sending service.
 * Sends messages via VPSMurah Unofficial API.
 */

import { config } from '../config';
import { logger } from '../utils/logger';

interface SendResult {
  success: boolean;
  error?: string;
}

/**
 * Send a text message to a WhatsApp chat via VPSMurah API.
 */
export async function sendMessage(chatId: string, text: string): Promise<SendResult> {
  if (!chatId || !text) {
    logger.whatsapp.warn('sendMessage called with empty chatId or text');
    return { success: false, error: 'Missing chatId or text' };
  }

  // Truncate overly long responses
  const maxResponseChars = 4096;
  const truncatedText = text.length > maxResponseChars
    ? text.substring(0, maxResponseChars) + '\n\n_(pesan terpotong karena terlalu panjang)_'
    : text;

  const payload = {
    id: chatId,
    message: truncatedText,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    logger.whatsapp.info(`Sending message to ${chatId.substring(0, 8)}...`);

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
      const errorBody = await response.text().catch(() => 'no body');
      logger.whatsapp.error(`VPSMurah API error: ${response.status} - ${errorBody}`);
      return { success: false, error: `API returned ${response.status}` };
    }

    logger.whatsapp.info(`Message sent successfully to ${chatId.substring(0, 8)}...`);
    return { success: true };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.whatsapp.error('VPSMurah API request timed out');
      return { success: false, error: 'Request timed out' };
    }
    logger.whatsapp.error('Failed to send message:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}
