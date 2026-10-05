/**
 * WhatsApp Client Service using @whiskeysockets/baileys.
 * Direct WhatsApp Web WebSocket connection with multi-file persistent auth.
 * Supports modern JIDs (@s.whatsapp.net, @lid, @g.us) and robust message handling.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  jidNormalizedUser,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';
import { config } from '../config';
import { logger } from '../utils/logger';
import { processIncomingMessage } from './messageProcessor';
import { IncomingMessage } from '../types/whatsapp';
import { isGroupChat, toBaileysJid } from '../utils/phone';

const pinoLogger = pino({ level: 'silent' });

let socket: WASocket | null = null;
let isConnecting = false;
let isConnected = false;
let latestQr: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

// Bot JIDs
let botPhoneJid: string | null = null;
let botLidJid: string | null = null;

// Diagnostics timestamps
let messageHandlerReady = false;
let lastUpsertAt: number | null = null;
let lastMessageAt: number | null = null;
let lastGeminiAt: number | null = null;
let lastReplyAt: number | null = null;
let lastError: string | null = null;

/**
 * Initialize and start the Baileys WhatsApp client.
 * Guarantees a single active socket connection and attaches message listeners.
 */
export async function initWhatsAppClient(): Promise<WASocket | null> {
  if (config.whatsappProvider !== 'baileys') {
    logger.whatsapp.info(`WhatsApp provider is set to ${config.whatsappProvider}, skipping Baileys init`);
    return null;
  }

  if (socket && isConnected) {
    logger.whatsapp.debug('WhatsApp client is already connected');
    return socket;
  }

  if (isConnecting) {
    logger.whatsapp.debug('Connection attempt already in progress, skipping redundant call');
    return socket;
  }

  // Cleanup old inactive socket before creating a new one
  if (socket && !isConnected) {
    try {
      socket.end(undefined);
    } catch {
      // ignore close errors
    }
    socket = null;
  }

  isConnecting = true;
  logger.whatsapp.info('Connecting');

  try {
    // Ensure persistent storage directory exists
    const authDir = path.resolve(config.whatsappAuthDir);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307] as [number, number, number],
    }));

    socket = makeWASocket({
      version,
      logger: pinoLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pinoLogger),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    // 1. Credentials update listener
    socket.ev.on('creds.update', saveCreds);

    // 2. Connection lifecycle listener
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQr = qr;
        logger.whatsapp.info('QR ready');
      }

      if (connection === 'close') {
        isConnected = false;
        latestQr = null;
        isConnecting = false;
        messageHandlerReady = false;
        logger.whatsapp.info('Connection closed');

        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.whatsapp.warn('Logged out from WhatsApp. Clearing session...');
          try {
            if (fs.existsSync(authDir)) {
              fs.rmSync(authDir, { recursive: true, force: true });
              fs.mkdirSync(authDir, { recursive: true });
            }
          } catch (cleanErr) {
            logger.error.error('Failed to clear session directory:', (cleanErr as Error).message);
          }
          scheduleReconnect(1000);
        } else if (shouldReconnect) {
          const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts), 30000);
          reconnectAttempts++;
          logger.whatsapp.info(`Reconnecting in ${Math.round(delay / 1000)}s...`);
          scheduleReconnect(delay);
        }
      } else if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        latestQr = null;
        reconnectAttempts = 0;

        if (socket?.user) {
          botPhoneJid = socket.user.id ? jidNormalizedUser(socket.user.id) : null;
          botLidJid = (socket.user as any)?.lid
            ? jidNormalizedUser(String((socket.user as any).lid))
            : null;
        }

        logger.whatsapp.info('Connected');
      }
    });

    // 3. Incoming message listener (always attached to active socket)
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      lastUpsertAt = Date.now();
      const count = messages?.length || 0;
      logger.whatsapp.info(`messages.upsert received count=${count} type=${type}`);

      if (!messages || messages.length === 0) {
        return;
      }

      for (const msg of messages) {
        const msgId = msg.key?.id || 'unknown';
        logger.whatsapp.info(`processing incoming message id=${msgId}`);

        try {
          await handleBaileysMessage(msg);
        } catch (err) {
          const errMsg = (err as Error).message;
          lastError = `Handler error: ${errMsg}`;
          logger.error.error('Error handling Baileys message:', errMsg);
        }
      }
    });

    messageHandlerReady = true;
    return socket;
  } catch (err) {
    isConnecting = false;
    messageHandlerReady = false;
    const errMsg = (err as Error).message;
    lastError = `Init error: ${errMsg}`;
    logger.error.error('Failed to initialize Baileys client:', errMsg);
    scheduleReconnect(5000);
    return null;
  }
}

/**
 * Schedule reconnect with backoff.
 */
function scheduleReconnect(delayMs: number): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWhatsAppClient().catch((err) => {
      logger.error.error('Reconnect failed:', (err as Error).message);
    });
  }, delayMs);
}

/**
 * Unwrap nested messages (ephemeral, viewOnce, documentWithCaption, edited).
 */
function unwrapMessage(msgContent: unknown): Record<string, any> | null {
  if (!msgContent || typeof msgContent !== 'object') {
    return null;
  }

  let current: any = normalizeMessageContent(msgContent as any) || msgContent;
  let depth = 0;

  while (depth < 5) {
    depth++;
    const inner =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message?.protocolMessage?.editedMessage;

    if (inner) {
      current = normalizeMessageContent(inner) || inner;
    } else {
      break;
    }
  }

  return current;
}

/**
 * Extract clean text and metadata from a Baileys WAMessage.
 * Supports @s.whatsapp.net, @lid, @g.us.
 */
export function extractBaileysMessage(msg: WAMessage): IncomingMessage | null {
  const key = msg.key;
  if (!key || !key.remoteJid) {
    logger.whatsapp.info('message ignored reason=missing key or remoteJid');
    return null;
  }

  const remoteJid = key.remoteJid;

  // Filter 1: Status broadcasts
  if (remoteJid === 'status@broadcast') {
    logger.whatsapp.info('message ignored reason=status broadcast');
    return null;
  }

  // Filter 2: Messages sent by the bot itself
  if (key.fromMe) {
    logger.whatsapp.info('message ignored reason=fromMe');
    return null;
  }

  const rawMessage = msg.message;
  if (!rawMessage) {
    logger.whatsapp.info('message ignored reason=empty message');
    return null;
  }

  // Filter 3: Unwrap nested wrappers
  const unwrapped = unwrapMessage(rawMessage);
  if (!unwrapped) {
    logger.whatsapp.info('message ignored reason=empty message');
    return null;
  }

  // Filter 4: Ignore protocol or reaction messages
  if (unwrapped.protocolMessage || unwrapped.reactionMessage) {
    logger.whatsapp.info('message ignored reason=protocol or reaction');
    return null;
  }

  // Extract text
  let text = '';
  let messageType = 'unknown';

  if (typeof unwrapped.conversation === 'string' && unwrapped.conversation) {
    text = unwrapped.conversation;
    messageType = 'text';
  } else if (unwrapped.extendedTextMessage?.text) {
    text = unwrapped.extendedTextMessage.text;
    messageType = 'text';
  } else if (unwrapped.imageMessage?.caption) {
    text = unwrapped.imageMessage.caption;
    messageType = 'image';
  } else if (unwrapped.videoMessage?.caption) {
    text = unwrapped.videoMessage.caption;
    messageType = 'video';
  } else if (unwrapped.documentMessage?.caption) {
    text = unwrapped.documentMessage.caption;
    messageType = 'document';
  } else if (unwrapped.imageMessage) {
    messageType = 'image';
  } else if (unwrapped.videoMessage) {
    messageType = 'video';
  } else if (unwrapped.audioMessage) {
    messageType = 'audio';
  } else if (unwrapped.documentMessage) {
    messageType = 'document';
  } else if (unwrapped.stickerMessage) {
    messageType = 'sticker';
  }

  const trimmedText = text.trim();

  // Filter 5: Ignore empty text
  if (!trimmedText) {
    logger.whatsapp.info('message ignored reason=empty message');
    return null;
  }

  logger.whatsapp.info('text message accepted');
  lastMessageAt = Date.now();

  // Mentions extraction
  const contextInfo =
    unwrapped.extendedTextMessage?.contextInfo ||
    unwrapped.imageMessage?.contextInfo ||
    unwrapped.videoMessage?.contextInfo ||
    unwrapped.documentMessage?.contextInfo;

  let mentionedIds: string[] = [];
  if (contextInfo?.mentionedJid && Array.isArray(contextInfo.mentionedJid)) {
    mentionedIds = contextInfo.mentionedJid.map((jid: unknown) => jidNormalizedUser(String(jid)));
  }

  const isGroup = isGroupChat(remoteJid);
  const senderId = isGroup
    ? jidNormalizedUser(key.participant || msg.participant || '')
    : jidNormalizedUser(remoteJid);

  const messageId = key.id || `baileys_${Date.now()}`;
  const timestamp = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp * 1000
    : Date.now();

  return {
    messageId,
    chatId: remoteJid, // Preserves EXACT remoteJid (@lid, @s.whatsapp.net, @g.us)
    senderId,
    senderName: msg.pushName || undefined,
    text: trimmedText,
    isGroup,
    isFromMe: Boolean(key.fromMe),
    mentionedIds,
    timestamp,
    messageType,
  };
}

/**
 * Handle a received Baileys message.
 */
async function handleBaileysMessage(msg: WAMessage): Promise<void> {
  const normalized = extractBaileysMessage(msg);
  if (!normalized) {
    return;
  }

  logger.whatsapp.info('Message received');
  await processIncomingMessage(normalized);
}

/**
 * Send message through active Baileys socket.
 * Sends directly to the exact target JID (@lid, @s.whatsapp.net, or @g.us).
 */
export async function sendBaileysMessage(
  jid: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  if (!socket || !isConnected) {
    logger.whatsapp.error('Cannot send message: Baileys is not connected');
    return { success: false, error: 'WhatsApp is not connected' };
  }

  try {
    logger.whatsapp.info('sending reply');
    await socket.sendMessage(jid, { text });
    logger.whatsapp.info('reply sent');
    lastReplyAt = Date.now();
    return { success: true };
  } catch (err) {
    const errorMsg = (err as Error).message || 'Failed to send message via Baileys';
    lastError = `Send failed: ${errorMsg}`;
    logger.whatsapp.error('Send failed:', errorMsg);
    return { success: false, error: errorMsg };
  }
}

export type WAPresenceType = 'composing' | 'paused' | 'available' | 'unavailable' | 'recording';

/**
 * Send presence update (typing / composing / paused) to WhatsApp.
 */
export async function sendBaileysPresence(
  jid: string,
  presence: WAPresenceType
): Promise<void> {
  if (!socket || !isConnected) {
    return;
  }

  try {
    if (typeof socket.sendPresenceUpdate === 'function') {
      await socket.sendPresenceUpdate(presence as any, jid);
    }
  } catch (err) {
    // Non-blocking: presence failure should never crash the bot
    logger.whatsapp.debug(`Presence update (${presence}) to ${jid} failed: ${(err as Error).message}`);
  }
}

export interface PresenceController {
  stop: () => void;
}

/**
 * Start periodic typing / composing indicator for a chat while AI is processing.
 * Refreshes every intervalMs (default 8000ms) until stopped.
 * Guarantees 'paused' is sent and timer cleared upon stopping.
 */
export function startTypingIndicator(chatId: string, intervalMs = 8000): PresenceController {
  const targetJid = toBaileysJid(chatId);
  let isStopped = false;

  // Send initial composing presence immediately
  sendBaileysPresence(targetJid, 'composing').catch(() => {});

  const interval = setInterval(() => {
    if (isStopped) return;
    sendBaileysPresence(targetJid, 'composing').catch(() => {});
  }, intervalMs);

  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  const stop = () => {
    if (isStopped) return;
    isStopped = true;
    clearInterval(interval);
    sendBaileysPresence(targetJid, 'paused').catch(() => {});
  };

  return { stop };
}

/**
 * Record a Gemini request timestamp for diagnostics.
 */
export function recordGeminiTimestamp(): void {
  lastGeminiAt = Date.now();
}

/**
 * Disconnect and stop Baileys client.
 */
export function disconnectWhatsApp(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.end(undefined);
    } catch {
      // ignore close errors
    }
    socket = null;
  }
  isConnected = false;
  isConnecting = false;
  messageHandlerReady = false;
  latestQr = null;
  botPhoneJid = null;
  botLidJid = null;
  logger.whatsapp.info('Disconnected');
}

/**
 * Get current connected bot identifiers (@s.whatsapp.net, @lid, configured number).
 */
export function getBotIdentifiers(): string[] {
  const ids: string[] = [];
  if (botPhoneJid) ids.push(botPhoneJid);
  if (botLidJid) ids.push(botLidJid);
  if (config.botWhatsappNumber) ids.push(config.botWhatsappNumber);
  return ids;
}

/**
 * Get current WhatsApp status for /health.
 */
export function getWhatsAppStatus(): {
  connected: boolean;
  pairingRequired: boolean;
  messageHandlerReady: boolean;
  lastMessageAt: number | null;
  lastReplyAt: number | null;
  provider: string;
} {
  return {
    connected: isConnected,
    pairingRequired: !isConnected && latestQr !== null,
    messageHandlerReady,
    lastMessageAt,
    lastReplyAt,
    provider: config.whatsappProvider,
  };
}

/**
 * Get full diagnostics data for GET /admin/status.
 */
export function getDiagnostics(): {
  connected: boolean;
  handlerReady: boolean;
  socketExists: boolean;
  lastUpsertAt: string | null;
  lastMessageAt: string | null;
  lastGeminiAt: string | null;
  lastReplyAt: string | null;
  lastError: string | null;
} {
  return {
    connected: isConnected,
    handlerReady: messageHandlerReady,
    socketExists: Boolean(socket),
    lastUpsertAt: lastUpsertAt ? new Date(lastUpsertAt).toISOString() : null,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
    lastGeminiAt: lastGeminiAt ? new Date(lastGeminiAt).toISOString() : null,
    lastReplyAt: lastReplyAt ? new Date(lastReplyAt).toISOString() : null,
    lastError,
  };
}

/**
 * Get current QR code string if pairing is needed.
 */
export function getLatestQr(): string | null {
  return latestQr;
}

/**
 * Export socket instance accessor for tests.
 */
export function getSocketInstance(): WASocket | null {
  return socket;
}

/**
 * Set test socket instance (for unit tests).
 */
export function setTestSocketInstance(mockSocket: WASocket | null, connected = true): void {
  socket = mockSocket;
  isConnected = connected;
  isConnecting = false;
  messageHandlerReady = Boolean(mockSocket);
  if (mockSocket?.user) {
    botPhoneJid = mockSocket.user.id ? jidNormalizedUser(mockSocket.user.id) : null;
    botLidJid = (mockSocket.user as any)?.lid
      ? jidNormalizedUser(String((mockSocket.user as any).lid))
      : null;
  }
}

/**
 * Reset all WhatsApp client state (for test cleanup).
 */
export function resetWhatsAppClientState(): void {
  disconnectWhatsApp();
  isConnecting = false;
  isConnected = false;
  reconnectAttempts = 0;
  lastUpsertAt = null;
  lastMessageAt = null;
  lastGeminiAt = null;
  lastReplyAt = null;
  lastError = null;
}
