/**
 * WhatsApp Client Service using @whiskeysockets/baileys.
 * Direct WhatsApp Web WebSocket connection with multi-file persistent auth.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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
import { isGroupChat, normalizePhone } from '../utils/phone';

const pinoLogger = pino({ level: 'silent' });

let socket: WASocket | null = null;
let isConnecting = false;
let isConnected = false;
let latestQr: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let botJid: string | null = null;

/**
 * Initialize and start the Baileys WhatsApp client.
 * Guarantees a single active socket connection.
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

    // Handle authentication credentials updates
    socket.ev.on('creds.update', saveCreds);

    // Handle connection lifecycle
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
          // Request new QR pairing
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
        botJid = socket?.user?.id ? normalizePhone(socket.user.id) : null;
        logger.whatsapp.info('Connected');
      }
    });

    // Handle incoming messages
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !messages || messages.length === 0) {
        return;
      }

      for (const msg of messages) {
        try {
          await handleBaileysMessage(msg);
        } catch (err) {
          logger.error.error('Error handling Baileys message:', (err as Error).message);
        }
      }
    });

    return socket;
  } catch (err) {
    isConnecting = false;
    logger.error.error('Failed to initialize Baileys client:', (err as Error).message);
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
 * Extract clean text and metadata from a Baileys WAMessage.
 */
export function extractBaileysMessage(msg: WAMessage): IncomingMessage | null {
  const key = msg.key;
  if (!key || !key.remoteJid) {
    return null;
  }

  const remoteJid = key.remoteJid;

  // Filter 1: Status broadcasts
  if (remoteJid === 'status@broadcast') {
    return null;
  }

  // Filter 2: Self messages
  if (key.fromMe) {
    return null;
  }

  const messageContent = msg.message;
  if (!messageContent) {
    return null;
  }

  // Filter 3: Protocol, reaction, or ephemeral wrapper
  const unwrapped =
    messageContent.ephemeralMessage?.message ||
    messageContent.viewOnceMessage?.message ||
    messageContent.viewOnceMessageV2?.message ||
    messageContent;

  if (unwrapped.protocolMessage || unwrapped.reactionMessage) {
    return null;
  }

  // Extract text
  let text = '';
  let messageType = 'unknown';

  if (typeof unwrapped.conversation === 'string') {
    text = unwrapped.conversation;
    messageType = 'text';
  } else if (unwrapped.extendedTextMessage?.text) {
    text = unwrapped.extendedTextMessage.text;
    messageType = 'text';
  } else if (unwrapped.imageMessage) {
    text = unwrapped.imageMessage.caption || '';
    messageType = 'image';
  } else if (unwrapped.videoMessage) {
    text = unwrapped.videoMessage.caption || '';
    messageType = 'video';
  } else if (unwrapped.audioMessage) {
    messageType = 'audio';
  } else if (unwrapped.documentMessage) {
    messageType = 'document';
  } else if (unwrapped.stickerMessage) {
    messageType = 'sticker';
  }

  // Mentions
  const contextInfo = unwrapped.extendedTextMessage?.contextInfo;
  let mentionedIds: string[] = [];
  if (contextInfo?.mentionedJid && Array.isArray(contextInfo.mentionedJid)) {
    mentionedIds = contextInfo.mentionedJid.map(String);
  }

  const isGroup = isGroupChat(remoteJid);
  const senderId = isGroup
    ? (key.participant || msg.participant || '')
    : remoteJid;

  const messageId = key.id || `baileys_${Date.now()}`;
  const timestamp = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp * 1000
    : Date.now();

  return {
    messageId,
    chatId: remoteJid,
    senderId,
    senderName: msg.pushName || undefined,
    text: text.trim(),
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
 * Send message through Baileys socket.
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
    await socket.sendMessage(jid, { text });
    logger.whatsapp.info('Reply sent');
    return { success: true };
  } catch (err) {
    const errorMsg = (err as Error).message || 'Failed to send message via Baileys';
    logger.whatsapp.error('Send failed:', errorMsg);
    return { success: false, error: errorMsg };
  }
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
  latestQr = null;
  logger.whatsapp.info('Disconnected');
}

/**
 * Get current WhatsApp status for /health.
 */
export function getWhatsAppStatus(): {
  connected: boolean;
  pairingRequired: boolean;
  botJid: string | null;
  provider: string;
} {
  return {
    connected: isConnected,
    pairingRequired: !isConnected && latestQr !== null,
    botJid,
    provider: config.whatsappProvider,
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
