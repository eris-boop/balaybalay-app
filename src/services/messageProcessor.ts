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
import { LoadedContext } from '../database/memoryRepository';
import { idempotency, generateDeterministicKey } from './idempotency';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getBotIdentifiers, recordGeminiTimestamp, startTypingIndicator } from './whatsappClient';
import { chatQueue } from '../utils/queue';
import { profanityFilter } from './profanityFilter';
import { getLastAIResult } from './aiService';
import { isBotSentMessage, recordBotSentMessage } from './botSentMessages';

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
 *
 * Architecture:
 * 1. Validate incoming text message & deduplicate.
 * 2. DATABASE-FIRST INGESTION: Persist raw user text to PostgreSQL (or spool if offline)
 *    and enqueue into background memory learner BEFORE AI call or reply decision.
 * 3. TRIGGER EVALUATION: Separate storage from response generation.
 *    - Private chat: respond if respondInPrivate=true.
 *    - Group chat: respond if mentioned, OR if replying/quoting a previous bot message,
 *      OR if groupReplyAlways=true.
 * 4. CONTEXT GENERATION: Build context with active facts, quoted message, recent history, summaries.
 * 5. PATIENT AI GENERATION: Execute with category timeout & failover.
 * 6. PERSIST ASSISTANT REPLY: Store in history (marked non-factual to prevent hallucination loops).
 * 7. SEND REPLY: Dispatch to WhatsApp and record message ID for reply-to-bot tracking.
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
  const rawText = message.text ? message.text.trim() : '';
  if (!rawText) {
    logger.whatsapp.info('message ignored reason=empty message');
    return false;
  }

  // ──────── STEP 1: DATABASE-FIRST INGESTION BEFORE AI ────────
  // All valid incoming text messages are stored in DB and enqueued for learning
  // even if the bot does not reply (e.g. random group discussion archived).
  const shouldStoreMessage = !message.isGroup || config.groupArchiveAllText;
  if (shouldStoreMessage) {
    try {
      await memory.saveUserMsg({
        chatId: message.chatId,
        isGroup: Boolean(message.isGroup),
        messageId: message.messageId,
        senderId: message.senderId,
        content: rawText,
        sourceType: message.isGroup ? 'group' : 'private',
        replyToMessageId: message.quotedStanzaId,
      });
      logger.whatsapp.info(`[ingest] message persisted source=${message.isGroup ? 'group' : 'private'}`);
    } catch (err) {
      logger.memory.warn('[ingest] user message persistence failed (non-blocking):', (err as Error).message);
    }
  }

  // ──────── STEP 2: DECIDE WHETHER BOT SHOULD REPLY ────────
  const botIdentifiers = getBotIdentifiers();
  const isMentioned = isBotMentioned(message, botIdentifiers);

  let isQuotingBot = Boolean(message.isQuotingBot);
  if (!isQuotingBot && message.quotedStanzaId) {
    isQuotingBot = await isBotSentMessage(message.quotedStanzaId);
  }

  let shouldReply = false;
  if (message.isGroup) {
    if (config.groupReplyAlways) {
      shouldReply = true;
    } else if (config.groupReplyOnMention && isMentioned) {
      shouldReply = true;
    } else if (config.groupReplyOnQuote && isQuotingBot) {
      shouldReply = true;
    }

    if (!shouldReply) {
      logger.whatsapp.info('message ignored reason=group message without bot mention');
      return false;
    }
  } else {
    // Private chat: direct response without mention
    if (!config.respondInPrivate) {
      logger.whatsapp.info('message ignored reason=private responses disabled');
      return false;
    }
    shouldReply = true;
  }

  // ──────── STEP 3: PREPARE PROMPT ────────
  let prompt = rawText;
  if (message.isGroup && isMentioned) {
    prompt = stripBotMention(prompt, botIdentifiers);
  }

  prompt = prompt.substring(0, config.maxInputChars);

  if (!prompt.trim()) {
    await sendMessage(message.chatId, 'Halo 👋 Ada yang bisa saya bantu?');
    logger.whatsapp.info('reply sent');
    return true;
  }

  // ──────── STEP 4: LOAD MEMORY CONTEXT ────────
  let context: LoadedContext;
  try {
    context = await memory.loadContext(message.chatId, prompt);
  } catch (memErr) {
    logger.memory.warn('[memory] context loading failed, continuing with in-memory context:', (memErr as Error).message);
    context = {
      recentHistory: memory.getHistory(message.chatId),
      summary: null,
      relevantOldMessages: [],
      globalRelevantMessages: [],
      globalSummary: null,
      activeFacts: [],
    };
  }

  const history = context.recentHistory;
  logger.ai.info(`history entries=${history.length}`);

  // Start WhatsApp typing / composing presence while AI generates answer
  const typingIndicator = startTypingIndicator(message.chatId);

  try {
    recordGeminiTimestamp();

    // ──────── STEP 5: GENERATE AI REPLY ────────
    const reply = await generateReply({
      message: prompt,
      senderName: message.senderName,
      chatId: message.chatId,
      history,
      summary: context.summary,
      relevantOldMessages: context.relevantOldMessages,
      globalRelevantMessages: context.globalRelevantMessages,
      globalSummary: context.globalSummary,
      activeFacts: context.activeFacts,
      quotedMessage: message.quotedText || null,
    });

    // ──────── STEP 6: PROFANITY FILTER ────────
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

    // ──────── STEP 7: SAVE ASSISTANT RESPONSE AFTER SUCCESS ────────
    try {
      const aiMeta = getLastAIResult();
      await memory.saveAssistantMsg({
        chatId: message.chatId,
        isGroup: Boolean(message.isGroup),
        content: filteredReply,
        modelUsed: aiMeta.modelUsed,
        taskType: aiMeta.taskType,
        memoryEligible: false, // Prevents hallucination feedback loops
      });

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
    } catch (err) {
      // Non-blocking
      logger.memory.warn('[memory] assistant persistence failed (non-blocking):', (err as Error).message);
    }

    // ──────── STEP 8: SEND REPLY ────────
    const sendResult = await sendMessage(message.chatId, filteredReply);
    if (sendResult.messageId) {
      await recordBotSentMessage(sendResult.messageId, message.chatId);
    }
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
      const fallbackResult = await sendMessage(message.chatId, fallbackText);
      if (fallbackResult.messageId) {
        await recordBotSentMessage(fallbackResult.messageId, message.chatId);
      }
      logger.whatsapp.info('reply sent');
    } catch {
      // ignore secondary send failure
    }
    return false;
  } finally {
    typingIndicator.stop();
  }
}
