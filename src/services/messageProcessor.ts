/**
 * Unified incoming message processor.
 * Used by Baileys WebSocket handler and webhook fallback.
 *
 * Filters:
 * - Ignores self messages (isFromMe or sender is bot)
 * - Ignores non-text messages
 * - Ignores empty text
 * - Deduplicates via idempotency cache (message.key.id)
 * - In group chats (@g.us): requires bot mention (@s.whatsapp.net or @lid)
 * - In private chats (@s.whatsapp.net or @lid): responds directly without mention
 * - Rate limits per sender
 * - Cleans mention from prompt before calling Gemini
 * - Persists conversation history
 * - Sends reply via WhatsApp service to exact remoteJid
 */

import { IncomingMessage } from '../types/whatsapp';
import { isBotMentioned, stripBotMention } from './mention';
import { generateReply } from './gemini';
import { sendMessage } from './whatsapp';
import { memory } from './memory';
import { idempotency, generateDeterministicKey } from './idempotency';
import { rateLimiter } from './rateLimit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getBotIdentifiers, recordGeminiTimestamp } from './whatsappClient';

export async function processIncomingMessage(message: IncomingMessage): Promise<boolean> {
  // Guard 1: ignore messages sent by the bot itself
  if (message.isFromMe) {
    logger.whatsapp.info('message ignored reason=fromMe');
    return false;
  }

  // Guard 2: idempotency check (anti-duplicate)
  const dedupeKey =
    message.messageId ||
    message.eventId ||
    generateDeterministicKey(message.chatId, message.senderId, message.timestamp, message.text);

  if (idempotency.isDuplicate(dedupeKey)) {
    logger.whatsapp.info('message ignored reason=duplicate');
    return false;
  }

  // Guard 3: message type check (only text messages supported for AI)
  if (message.messageType && message.messageType !== 'text') {
    logger.whatsapp.info('message ignored reason=unsupported message type');
    return false;
  }

  // Guard 4: empty message check
  if (!message.text || !message.text.trim()) {
    logger.whatsapp.info('message ignored reason=empty message');
    return false;
  }

  // Guard 5: chat type & mention policy
  if (message.isGroup) {
    // In group chat: bot MUST be mentioned
    const botIdentifiers = getBotIdentifiers();
    if (!isBotMentioned(message, botIdentifiers)) {
      logger.whatsapp.info('message ignored reason=group message without bot mention');
      return false;
    }
  } else {
    // In private chat (@s.whatsapp.net OR @lid): direct response, NO MENTION REQUIRED
    if (!config.respondInPrivate) {
      logger.whatsapp.info('message ignored reason=private responses disabled');
      return false;
    }
  }

  // Guard 6: rate limiting
  const rateLimitKey = message.senderId || message.chatId;
  if (rateLimiter.isRateLimited(rateLimitKey)) {
    if (rateLimiter.isFirstWarning(rateLimitKey)) {
      await sendMessage(
        message.chatId,
        'Mohon tunggu sebentar ya, kamu mengirim pesan terlalu cepat. 🙏'
      );
    }
    return false;
  }

  // Prepare prompt: strip bot mention from group messages
  let prompt = message.text;
  if (message.isGroup) {
    prompt = stripBotMention(prompt, getBotIdentifiers());
  }

  // Truncate to max input chars
  prompt = prompt.substring(0, config.maxInputChars);

  // If prompt is empty after removing mention, send friendly greeting
  if (!prompt.trim()) {
    await sendMessage(message.chatId, 'Halo 👋 Ada yang bisa saya bantu?');
    return true;
  }

  // Retrieve chat history
  const history = memory.getHistory(message.chatId);

  try {
    recordGeminiTimestamp();

    // Generate AI reply via Gemini
    const reply = await generateReply({
      message: prompt,
      senderName: message.senderName,
      chatId: message.chatId,
      history,
    });

    // Store user message & assistant reply in conversation memory
    memory.addEntry(message.chatId, {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    memory.addEntry(message.chatId, {
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
    });

    // Send reply back to EXACT remoteJid
    await sendMessage(message.chatId, reply);
    return true;
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error.error('Gemini processing failed, handled gracefully:', errMsg);
    try {
      await sendMessage(
        message.chatId,
        'Maaf, saya sedang mengalami kendala teknis saat memproses pesan Anda. Silakan coba lagi sebentar ya.'
      );
    } catch {
      // ignore secondary error
    }
    return false;
  }
}
