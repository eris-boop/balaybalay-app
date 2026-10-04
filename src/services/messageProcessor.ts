/**
 * Unified incoming message processor.
 * Used by both polling service (GET /wa-api/inbox) and webhook handler.
 *
 * Filters:
 * - Ignores self messages (isFromMe or sender is bot number)
 * - Ignores non-text messages
 * - Ignores empty text
 * - Deduplicates via idempotency cache (messageId or deterministic key)
 * - In group chats: requires bot mention
 * - In private chats: requires RESPOND_IN_PRIVATE=true
 * - Rate limits per sender
 * - Cleans mention from prompt before calling Gemini
 * - Persists conversation history
 * - Sends reply via WhatsApp service
 */

import { IncomingMessage } from '../types/whatsapp';
import { isBotMentioned, stripBotMention } from './mention';
import { generateReply } from './gemini';
import { sendMessage } from './whatsapp';
import { memory } from './memory';
import { idempotency, generateDeterministicKey } from './idempotency';
import { rateLimiter } from './rateLimit';
import { config } from '../config';
import { phoneEquals } from '../utils/phone';
import { logger } from '../utils/logger';

export async function processIncomingMessage(message: IncomingMessage): Promise<boolean> {
  // Guard 1: ignore messages sent by the bot itself
  if (message.isFromMe) {
    logger.polling.debug('Ignoring message from self (isFromMe=true)');
    return false;
  }

  if (message.senderId && phoneEquals(message.senderId, config.botWhatsappNumber)) {
    logger.polling.debug('Ignoring message from bot WhatsApp number');
    return false;
  }

  // Guard 2: idempotency check (anti-duplicate)
  const dedupeKey =
    message.messageId ||
    message.eventId ||
    generateDeterministicKey(message.chatId, message.senderId, message.timestamp, message.text);

  if (idempotency.isDuplicate(dedupeKey)) {
    logger.polling.debug(`Duplicate message ignored: ${dedupeKey}`);
    return false;
  }

  // Guard 3: message type check (only text messages supported for AI)
  if (message.messageType && message.messageType !== 'text') {
    logger.polling.debug(`Ignoring unsupported message type: ${message.messageType}`);
    return false;
  }

  // Guard 4: empty message check
  if (!message.text || !message.text.trim()) {
    logger.polling.debug('Ignoring empty text message');
    return false;
  }

  // Guard 5: chat type & mention policy
  if (message.isGroup) {
    // In group chat: bot MUST be mentioned
    if (!isBotMentioned(message, config.botWhatsappNumber)) {
      logger.polling.debug('Bot not mentioned in group message, ignoring without calling Gemini');
      return false;
    }
  } else {
    // In private chat: check if private responses are enabled
    if (!config.respondInPrivate) {
      logger.polling.debug('Private chat responses disabled (RESPOND_IN_PRIVATE=false), ignoring');
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
    prompt = stripBotMention(prompt, config.botWhatsappNumber);
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

  // Send reply back to WhatsApp
  await sendMessage(message.chatId, reply);
  return true;
}
