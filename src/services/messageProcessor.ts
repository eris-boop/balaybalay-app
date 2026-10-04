/**
 * Unified incoming message processor.
 * Used by Baileys WebSocket handler and webhook fallback.
 *
 * Features:
 * - Per-chat concurrency queue (mutex) to prevent race conditions on conversation history
 * - Ignores self messages (isFromMe or sender is bot)
 * - Ignores non-text messages
 * - Ignores empty text
 * - Deduplicates via idempotency cache (message.key.id)
 * - In group chats (@g.us): requires bot mention (@s.whatsapp.net or @lid)
 * - In private chats (@s.whatsapp.net or @lid): responds directly without mention
 * - Cleans mention from prompt before calling Gemini
 * - Saves user message to PostgreSQL BEFORE AI call (persists even if AI fails)
 * - Saves assistant response AFTER AI succeeds (with profanity filtering applied)
 * - Never saves fallback/error messages into conversation history as memory-eligible
 * - Sends reply via WhatsApp service to exact remoteJid
 */

import { IncomingMessage } from '../types/whatsapp';
import { isBotMentioned, stripBotMention } from './mention';
import { generateReply, GeminiProviderError } from './gemini';
import { sendMessage } from './whatsapp';
import { memory } from './memory';
import { idempotency, generateDeterministicKey } from './idempotency';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getBotIdentifiers, recordGeminiTimestamp } from './whatsappClient';
import { chatQueue } from '../utils/queue';
import { profanityFilter, filterProfanity } from './profanityFilter';
import { getLastAIResult } from './aiService';

/**
 * Process an incoming message with per-chat serialization.
 */
export async function processIncomingMessage(message: IncomingMessage): Promise<boolean> {
  return chatQueue.run(message.chatId, async () => {
    return executeMessageProcessing(message);
  });
}

/**
 * Core processing logic for an incoming message.
 */
async function executeMessageProcessing(message: IncomingMessage): Promise<boolean> {
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
    logger.memory.info('[memory] duplicate message skipped');
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
    logger.whatsapp.info('reply sent');
    return true;
  }

  // ──────── STEP 1: SAVE USER MESSAGE BEFORE AI ────────
  // User message persists to PostgreSQL immediately, even if AI later fails.
  try {
    await memory.saveUserMsg({
      chatId: message.chatId,
      isGroup: Boolean(message.isGroup),
      messageId: message.messageId,
      senderId: message.senderId,
      content: prompt,
      sourceType: message.isGroup ? 'group' : 'private',
    });
  } catch (err) {
    // Non-blocking: persistence failure should not prevent AI response
    logger.memory.warn('[memory] user message persistence failed (non-blocking):', (err as Error).message);
  }

  // ──────── STEP 2: LOAD MEMORY CONTEXT ────────
  const context = await memory.loadContext(message.chatId, prompt);
  const history = context.recentHistory;
  logger.ai.info(`history entries=${history.length}`);

  try {
    recordGeminiTimestamp();

    // ──────── STEP 3: GENERATE AI REPLY ────────
    const reply = await generateReply({
      message: prompt,
      senderName: message.senderName,
      chatId: message.chatId,
      history,
      summary: context.summary,
      relevantOldMessages: context.relevantOldMessages,
      globalRelevantMessages: context.globalRelevantMessages,
      globalSummary: context.globalSummary,
    });

    // ──────── STEP 4: PROFANITY FILTER ────────
    let filteredReply = reply;
    try {
      filteredReply = profanityFilter.mask(reply);
    } catch (profErr) {
      logger.profanity.warn(
        'Profanity filtering unexpectedly failed, falling back to raw response:',
        (profErr as Error).message
      );
      filteredReply = reply;
    }

    // ──────── STEP 5: SAVE ASSISTANT RESPONSE AFTER SUCCESS ────────
    const aiMeta = getLastAIResult();
    try {
      await memory.saveAssistantMsg({
        chatId: message.chatId,
        isGroup: Boolean(message.isGroup),
        content: filteredReply,
        modelUsed: aiMeta.modelUsed,
        taskType: aiMeta.taskType,
        memoryEligible: true,
      });
    } catch (err) {
      // Non-blocking
      logger.memory.warn('[memory] assistant persistence failed (non-blocking):', (err as Error).message);
    }

    // Record successful turn in in-memory store for future turns in current session
    memory.addEntry(message.chatId, {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });
    memory.addEntry(message.chatId, {
      role: 'assistant',
      content: filteredReply,
      timestamp: Date.now(),
    });

    logger.memory.info('transaction committed');

    // ──────── STEP 6: SEND REPLY ────────
    await sendMessage(message.chatId, filteredReply);
    logger.whatsapp.info('reply sent');
    return true;
  } catch (err) {
    logger.memory.warn('AI failed - user message already persisted');
    const error = err as any;
    logger.error.error('Gemini processing failed, handled gracefully:', error?.message || String(error));

    // Determine fallback text based on provider error
    let fallbackText = 'AI sedang mengalami gangguan sementara. Coba lagi beberapa saat ya.';
    if (
      config.aiProvider === 'gemini' &&
      ((error instanceof GeminiProviderError && error.isRateLimit) ||
        error?.isRateLimit ||
        String(error?.message).includes('429') ||
        String(error?.message).includes('RESOURCE_EXHAUSTED'))
    ) {
      fallbackText = 'AI sedang ramai sebentar. Coba lagi beberapa saat ya.';
    }

    // Send friendly user fallback; DO NOT save fallback error to conversation history!
    try {
      await sendMessage(message.chatId, fallbackText);
      logger.whatsapp.info('reply sent');
    } catch {
      // ignore secondary send failure
    }
    return false;
  }
}
