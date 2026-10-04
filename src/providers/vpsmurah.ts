/**
 * VPSMurah WhatsApp Unofficial API adapter.
 *
 * Normalizes the provider-specific webhook payload into
 * our internal IncomingMessage interface.
 *
 * The VPSMurah Unofficial API is Baileys-based, so webhook payloads
 * typically follow the Baileys/WhatsApp Web structure. However, exact
 * field names may vary between provider versions.
 *
 * This adapter uses a flexible mapping approach:
 * - Tries multiple known field paths for each required value.
 * - Falls back gracefully when fields are missing.
 * - Logs unrecognized payload structures for debugging.
 *
 * If the actual webhook format differs from what's handled here,
 * only this file needs to be updated.
 */

import { IncomingMessage } from '../types/whatsapp';
import { isGroupChat } from '../utils/phone';
import { logger } from '../utils/logger';

/**
 * Attempt to extract a value from nested object paths.
 */
function deepGet(obj: Record<string, unknown>, ...paths: string[]): unknown {
  for (const path of paths) {
    const keys = path.split('.');
    let current: unknown = obj;
    let found = true;
    for (const key of keys) {
      if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[key];
      } else {
        found = false;
        break;
      }
    }
    if (found && current !== undefined && current !== null) {
      return current;
    }
  }
  return undefined;
}

/**
 * Parse the raw webhook body from VPSMurah into our internal message format.
 * Returns null if the payload cannot be parsed into a usable text message.
 */
export function parseVpsmurahWebhook(body: unknown): IncomingMessage | null {
  if (!body || typeof body !== 'object') {
    logger.webhook.warn('Received non-object webhook body');
    return null;
  }

  const raw = body as Record<string, unknown>;

  // --- Event type detection ---
  // VPSMurah may wrap payloads with an event type field
  const eventType = deepGet(raw, 'event', 'type', 'action') as string | undefined;

  // Only process message events; ignore status/presence/typing events
  if (eventType) {
    const normalized = String(eventType).toLowerCase();
    const messageEvents = ['message', 'messages', 'message.received', 'chat', 'incoming'];
    const ignoreEvents = [
      'status', 'presence', 'typing', 'read', 'receipt',
      'connection', 'qr', 'authenticated', 'disconnected',
      'call', 'group_update', 'group_participants_update',
    ];

    if (ignoreEvents.some((e) => normalized.includes(e))) {
      logger.webhook.debug(`Ignoring event type: ${eventType}`);
      return null;
    }

    if (!messageEvents.some((e) => normalized.includes(e)) && messageEvents.length > 0) {
      logger.webhook.debug(`Unrecognized event type: ${eventType}, attempting parse anyway`);
    }
  }

  // --- Message data extraction ---
  // The actual message object might be nested under a wrapper field (e.g., raw.data),
  // or the raw payload itself might BE the message object (flat Baileys format).
  // We check for wrapper fields first; if none found, use raw directly.
  let messageObj: Record<string, unknown>;

  if (raw.data && typeof raw.data === 'object') {
    // Wrapped: { event: "...", data: { key: {...}, message: {...}, ... } }
    messageObj = raw.data as Record<string, unknown>;
  } else if (raw.messages && Array.isArray(raw.messages) && (raw.messages as unknown[]).length > 0) {
    // Array wrapper: { messages: [{ key: {...}, message: {...} }] }
    messageObj = (raw.messages as unknown[])[0] as Record<string, unknown>;
  } else if (raw.msg && typeof raw.msg === 'object') {
    // Alternative wrapper: { msg: { key: {...}, message: {...} } }
    messageObj = raw.msg as Record<string, unknown>;
  } else {
    // Flat: the raw payload IS the message object
    messageObj = raw;
  }

  // Message key (Baileys structure: key.id, key.remoteJid, key.fromMe)
  const key = (deepGet(messageObj, 'key') || {}) as Record<string, unknown>;

  // Message ID
  const messageId = String(
    deepGet(raw, 'id', 'eventId') ||
    deepGet(key, 'id') ||
    deepGet(messageObj, 'messageId', 'id', 'msgId') ||
    `unknown_${Date.now()}`
  );

  // Event ID for idempotency (may differ from message ID)
  const eventId = String(
    deepGet(raw, 'eventId', 'event_id', 'webhook_id') || messageId
  );

  // Chat ID (where to send the reply)
  const chatId = String(
    deepGet(key, 'remoteJid') ||
    deepGet(messageObj, 'chatId', 'chat_id', 'chat', 'from', 'jid', 'remoteJid') ||
    deepGet(raw, 'chatId', 'chat_id', 'from') ||
    ''
  );

  if (!chatId) {
    logger.webhook.warn('Could not extract chatId from webhook payload');
    return null;
  }

  // Sender ID
  const isGroup = isGroupChat(chatId);

  const senderId = String(
    deepGet(messageObj, 'participant', 'sender', 'senderId', 'sender_id') ||
    deepGet(key, 'participant') ||
    deepGet(raw, 'participant', 'sender', 'senderId') ||
    (isGroup ? '' : chatId)
  );

  // Sender name
  const senderName = (
    deepGet(messageObj, 'pushName', 'senderName', 'sender_name', 'notifyName') ||
    deepGet(raw, 'pushName', 'senderName', 'sender_name') ||
    undefined
  ) as string | undefined;

  // isFromMe
  const isFromMe = Boolean(
    deepGet(key, 'fromMe') ??
    deepGet(messageObj, 'fromMe', 'from_me', 'isFromMe') ??
    deepGet(raw, 'fromMe', 'from_me') ??
    false
  );

  // --- Text extraction ---
  // Baileys stores text in message.conversation or message.extendedTextMessage.text
  const msgContent = deepGet(messageObj, 'message') as Record<string, unknown> | undefined;

  let text = '';
  let messageType = 'unknown';

  if (msgContent && typeof msgContent === 'object') {
    // Text message
    if (typeof msgContent.conversation === 'string') {
      text = msgContent.conversation;
      messageType = 'text';
    }
    // Extended text (replies, links, mentions)
    else if (msgContent.extendedTextMessage && typeof msgContent.extendedTextMessage === 'object') {
      const ext = msgContent.extendedTextMessage as Record<string, unknown>;
      text = String(ext.text || '');
      messageType = 'text';
    }
    // Image with caption
    else if (msgContent.imageMessage) {
      const img = msgContent.imageMessage as Record<string, unknown>;
      text = String(img.caption || '');
      messageType = 'image';
    }
    // Video with caption
    else if (msgContent.videoMessage) {
      const vid = msgContent.videoMessage as Record<string, unknown>;
      text = String(vid.caption || '');
      messageType = 'video';
    }
    // Document
    else if (msgContent.documentMessage) {
      messageType = 'document';
    }
    // Audio / voice note
    else if (msgContent.audioMessage) {
      messageType = 'audio';
    }
    // Sticker
    else if (msgContent.stickerMessage) {
      messageType = 'sticker';
    }
    // Other
    else {
      const keys = Object.keys(msgContent);
      messageType = keys[0] || 'unknown';
    }
  } else {
    // Flat payload structure - try direct text fields
    text = String(
      deepGet(messageObj, 'text', 'body', 'content', 'caption') ||
      deepGet(raw, 'text', 'body', 'content') ||
      ''
    );
    if (text) messageType = 'text';
  }

  // --- Mentions extraction ---
  let mentionedIds: string[] = [];

  // Baileys: extendedTextMessage.contextInfo.mentionedJid
  const contextInfo = (
    deepGet(msgContent || {}, 'extendedTextMessage.contextInfo') ||
    deepGet(messageObj, 'contextInfo') ||
    deepGet(raw, 'contextInfo')
  ) as Record<string, unknown> | undefined;

  if (contextInfo) {
    const mentioned = contextInfo.mentionedJid || contextInfo.mentionedIds || contextInfo.mentioned;
    if (Array.isArray(mentioned)) {
      mentionedIds = mentioned.map(String);
    }
  }

  // Also check flat mentions field
  if (mentionedIds.length === 0) {
    const flatMentions = deepGet(raw, 'mentions', 'mentionedIds', 'mentionedJids');
    if (Array.isArray(flatMentions)) {
      mentionedIds = flatMentions.map(String);
    }
  }

  // --- Timestamp ---
  const timestamp = Number(
    deepGet(messageObj, 'messageTimestamp') ||
    deepGet(raw, 'timestamp', 'messageTimestamp', 'time') ||
    Math.floor(Date.now() / 1000)
  );

  // Convert seconds to milliseconds if needed
  const tsMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;

  return {
    eventId,
    messageId,
    chatId,
    senderId,
    senderName,
    text: text.trim(),
    isGroup,
    isFromMe,
    mentionedIds,
    timestamp: tsMs,
    messageType,
  };
}
