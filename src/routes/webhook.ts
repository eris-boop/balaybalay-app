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
import { processIncomingMessage } from '../services/messageProcessor';
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
 * POST /webhook - Incoming WhatsApp event handler (manual/test webhook).
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

  await processIncomingMessage(message);
}
