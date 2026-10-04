/**
 * VPSMurah /wa-api/inbox response adapter.
 *
 * Normalizes raw inbox responses from GET /wa-api/inbox into an array
 * of internal IncomingMessage objects.
 *
 * Defensive implementation:
 * - Supports direct array of messages or nested structures (data, messages, inbox, result)
 * - Supports Baileys message structure as well as flat gateway structures
 * - Never crashes on unexpected event types, media, or missing fields
 * - Generates deterministic messageId fallback if missing
 * - In development mode, logs safe structure summaries without secrets/full numbers
 */

import { IncomingMessage } from '../types/whatsapp';
import { isGroupChat } from '../utils/phone';
import { generateDeterministicKey } from '../services/idempotency';
import { logger } from '../utils/logger';
import { config } from '../config';

let hasLoggedSampleStructure = false;

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
 * Parse an individual item from the inbox payload into IncomingMessage.
 */
function parseInboxItem(item: unknown): IncomingMessage | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const raw = item as Record<string, unknown>;

  // Check event/type field to filter out non-message events
  const eventType = deepGet(raw, 'event', 'type', 'action') as string | undefined;
  if (eventType) {
    const normalized = String(eventType).toLowerCase();
    const ignoreEvents = [
      'status', 'presence', 'typing', 'read', 'receipt',
      'connection', 'qr', 'authenticated', 'disconnected',
      'call', 'group_update',
    ];
    if (ignoreEvents.some((e) => normalized.includes(e))) {
      return null;
    }
  }

  // Identify message wrapper if nested (e.g. item.data or item.message or item itself)
  const messageObj = (
    (raw.key ? raw : null) ||
    (raw.data && typeof raw.data === 'object' ? raw.data : null) ||
    raw
  ) as Record<string, unknown>;

  // Key info (Baileys format)
  const key = (deepGet(messageObj, 'key') || {}) as Record<string, unknown>;

  // Chat ID
  const chatId = String(
    deepGet(key, 'remoteJid') ||
    deepGet(messageObj, 'chatId', 'chat_id', 'chat', 'from', 'jid', 'remoteJid') ||
    deepGet(raw, 'chatId', 'chat_id', 'from', 'jid') ||
    ''
  ).trim();

  if (!chatId) {
    return null;
  }

  const isGroup = isGroupChat(chatId);

  // Sender ID
  const senderId = String(
    deepGet(messageObj, 'participant', 'sender', 'senderId', 'sender_id') ||
    deepGet(key, 'participant') ||
    deepGet(raw, 'participant', 'sender', 'senderId') ||
    (isGroup ? '' : chatId)
  ).trim();

  // Sender Name
  const senderName = (
    deepGet(messageObj, 'pushName', 'senderName', 'sender_name', 'notifyName', 'name') ||
    deepGet(raw, 'pushName', 'senderName', 'sender_name', 'notifyName') ||
    undefined
  ) as string | undefined;

  // isFromMe
  const isFromMe = Boolean(
    deepGet(key, 'fromMe') ??
    deepGet(messageObj, 'fromMe', 'from_me', 'isFromMe') ??
    deepGet(raw, 'fromMe', 'from_me') ??
    false
  );

  // Text content & message type extraction
  const msgContent = deepGet(messageObj, 'message') as Record<string, unknown> | undefined;
  let text = '';
  let messageType = 'unknown';

  if (msgContent && typeof msgContent === 'object') {
    if (typeof msgContent.conversation === 'string') {
      text = msgContent.conversation;
      messageType = 'text';
    } else if (msgContent.extendedTextMessage && typeof msgContent.extendedTextMessage === 'object') {
      const ext = msgContent.extendedTextMessage as Record<string, unknown>;
      text = String(ext.text || '');
      messageType = 'text';
    } else if (msgContent.imageMessage) {
      const img = msgContent.imageMessage as Record<string, unknown>;
      text = String(img.caption || '');
      messageType = 'image';
    } else if (msgContent.videoMessage) {
      const vid = msgContent.videoMessage as Record<string, unknown>;
      text = String(vid.caption || '');
      messageType = 'video';
    } else if (msgContent.audioMessage) {
      messageType = 'audio';
    } else if (msgContent.documentMessage) {
      messageType = 'document';
    } else if (msgContent.stickerMessage) {
      messageType = 'sticker';
    } else {
      const keys = Object.keys(msgContent);
      messageType = keys[0] || 'unknown';
    }
  } else {
    // Flat text fields
    text = String(
      deepGet(messageObj, 'text', 'body', 'content', 'message') ||
      deepGet(raw, 'text', 'body', 'content') ||
      ''
    );
    if (text) messageType = 'text';
  }

  // Mentions
  let mentionedIds: string[] = [];
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

  if (mentionedIds.length === 0) {
    const flatMentions = deepGet(raw, 'mentions', 'mentionedIds', 'mentionedJids');
    if (Array.isArray(flatMentions)) {
      mentionedIds = flatMentions.map(String);
    }
  }

  // Timestamp
  const rawTimestamp = Number(
    deepGet(messageObj, 'messageTimestamp') ||
    deepGet(raw, 'timestamp', 'messageTimestamp', 'time', 'createdAt') ||
    Math.floor(Date.now() / 1000)
  );
  const timestamp = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;

  // Message ID with deterministic fallback if missing
  const rawId = deepGet(raw, 'id', 'eventId', 'messageId', 'msgId') ||
    deepGet(key, 'id') ||
    deepGet(messageObj, 'messageId', 'id', 'msgId');

  const messageId = rawId
    ? String(rawId)
    : generateDeterministicKey(chatId, senderId, timestamp, text);

  return {
    messageId,
    chatId,
    senderId,
    senderName,
    text: text.trim(),
    isGroup,
    isFromMe,
    mentionedIds,
    timestamp,
    messageType,
  };
}

/**
 * Parse the raw body from GET /wa-api/inbox into an array of IncomingMessage.
 */
export function parseVpsmurahInbox(body: unknown): IncomingMessage[] {
  if (!body) {
    return [];
  }

  let items: unknown[] = [];

  if (Array.isArray(body)) {
    items = body;
  } else if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;

    if (Array.isArray(obj.data)) {
      items = obj.data;
    } else if (Array.isArray(obj.messages)) {
      items = obj.messages;
    } else if (Array.isArray(obj.inbox)) {
      items = obj.inbox;
    } else if (Array.isArray(obj.result)) {
      items = obj.result;
    } else if (Array.isArray(obj.items)) {
      items = obj.items;
    } else if (obj.data && typeof obj.data === 'object' && Array.isArray((obj.data as Record<string, unknown>).messages)) {
      items = (obj.data as Record<string, unknown>).messages as unknown[];
    } else if (obj.chatId || obj.key || obj.text || obj.from) {
      // Single message object returned
      items = [obj];
    }
  }

  // In development mode, log safe structure keys on first payload to assist debugging
  if (config.nodeEnv === 'development' && !hasLoggedSampleStructure && items.length > 0) {
    const sample = items[0];
    if (sample && typeof sample === 'object') {
      const keys = Object.keys(sample as Record<string, unknown>);
      logger.polling.debug(`Sample inbox payload structure detected with keys: [${keys.join(', ')}]`);
    }
    hasLoggedSampleStructure = true;
  }

  const results: IncomingMessage[] = [];
  for (const item of items) {
    const parsed = parseInboxItem(item);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}
