/**
 * Webhook route handler.
 * Receives incoming WhatsApp events, processes them, and dispatches AI replies.
 *
 * Key behaviors:
 * - Acknowledges webhook immediately (HTTP 200) before processing.
 * - Ignores messages from the bot itself.
 * - In groups: only responds when the bot is mentioned.
 * - In private chats: responds if RESPOND_IN_PRIVATE is true.
 * - Strips bot mention from text before sending to AI.
 * - Prevents duplicate processing via idempotency cache.
 * - Rate limits per sender.
 */

import { Router, Request, Response } from 'express';
import { parseVpsmurahWebhook } from '../providers/vpsmurah';
import { isBotMentioned, stripBotMention } from '../services/mention';
import { generateReply } from '../services/gemini';
import { sendMessage } from '../services/whatsapp';
import { memory } from '../services/memory';
import { idempotency } from '../services/idempotency';
import { rateLimiter } from '../services/rateLimit';
import { config } from '../config';
import { phoneEquals } from '../utils/phone';
import { logger } from '../utils/logger';

export const webhookRouter = Router();

/**
 * GET /webhook - Verification endpoint.
 * Some providers require GET verification when registering a webhook URL.
 */
webhookRouter.get('/', (_req: Request, res: Response) => {
  logger.webhook.info('Webhook verification request received');
  res.status(200).json({
    status: 'ok',
    message: 'Webhook endpoint is active',
  });
});

/**
 * POST /webhook - Incoming WhatsApp event handler.
 */
webhookRouter.post('/', (req: Request, res: Response) => {
  // Acknowledge immediately to prevent provider retries
  res.status(200).json({ status: 'received' });

  // Process asynchronously
  processWebhook(req.body).catch((err) => {
    logger.error.error('Unhandled error in webhook processing:', (err as Error).message);
  });
});

async function processWebhook(body: unknown): Promise<void> {
  // --- Webhook signature verification (if configured) ---
  if (config.vpsmurahWebhookSecret) {
    // NOTE: Implement signature verification here when VPSMurah provides
    // a webhook signing mechanism. Currently, VPSMurah's unofficial API
    // documentation does not specify a signature verification method.
    // The VPSMURAH_WEBHOOK_SECRET env var is reserved for future use.
  }

  // --- Parse webhook payload ---
  const message = parseVpsmurahWebhook(body);

  if (!message) {
    logger.webhook.debug('Webhook payload could not be parsed into a message, ignoring');
    return;
  }

  logger.webhook.info(
    `Incoming ${message.messageType || 'unknown'} message: ` +
    `chat=${message.chatId.substring(0, 12)}... ` +
    `sender=${message.senderId.substring(0, 8)}... ` +
    `group=${message.isGroup} fromMe=${message.isFromMe}`
  );

  // --- Guard: ignore own messages ---
  if (message.isFromMe) {
    logger.webhook.debug('Ignoring message from self');
    return;
  }

  // Double check sender is not the bot itself
  if (message.senderId && phoneEquals(message.senderId, config.botWhatsappNumber)) {
    logger.webhook.debug('Ignoring message from bot number');
    return;
  }

  // --- Guard: idempotency ---
  const dedupeKey = message.eventId || message.messageId;
  if (idempotency.isDuplicate(dedupeKey)) {
    logger.webhook.debug(`Duplicate message ${dedupeKey}, skipping`);
    return;
  }

  // --- Guard: only text messages are processed for AI ---
  if (message.messageType && message.messageType !== 'text') {
    logger.webhook.info(`Unsupported message type: ${message.messageType}, ignoring`);
    return;
  }

  if (!message.text) {
    logger.webhook.debug('Empty text message, ignoring');
    return;
  }

  // --- Guard: group mention check ---
  if (message.isGroup) {
    if (!isBotMentioned(message, config.botWhatsappNumber)) {
      logger.webhook.debug('Bot not mentioned in group, ignoring');
      return;
    }
  } else {
    // Private chat
    if (!config.respondInPrivate) {
      logger.webhook.debug('Private chat responses disabled, ignoring');
      return;
    }
  }

  // --- Guard: rate limit ---
  const rateLimitKey = message.senderId || message.chatId;
  if (rateLimiter.isRateLimited(rateLimitKey)) {
    if (rateLimiter.isFirstWarning(rateLimitKey)) {
      await sendMessage(
        message.chatId,
        'Mohon tunggu sebentar ya, kamu mengirim pesan terlalu cepat. 🙏'
      );
    }
    return;
  }

  // --- Prepare prompt ---
  let prompt = message.text;

  // Strip bot mention from group messages
  if (message.isGroup) {
    prompt = stripBotMention(prompt, config.botWhatsappNumber);
  }

  // Truncate to max input
  prompt = prompt.substring(0, config.maxInputChars);

  // Handle empty prompt after stripping
  if (!prompt.trim()) {
    await sendMessage(message.chatId, 'Halo 👋 Ada yang bisa saya bantu?');
    return;
  }

  // --- Generate AI response ---
  const history = memory.getHistory(message.chatId);

  const reply = await generateReply({
    message: prompt,
    senderName: message.senderName,
    chatId: message.chatId,
    history,
  });

  // --- Store conversation ---
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

  // --- Send reply ---
  await sendMessage(message.chatId, reply);
}
