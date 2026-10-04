/**
 * PostgreSQL Memory Repository with Shared Global Memory.
 *
 * Implements:
 * 1. Individual message persistence (user + assistant, separately).
 * 2. Retrieval of recent history per chat (chronological oldest -> newest).
 * 3. PostgreSQL Full-Text Search for per-chat AND global cross-chat relevant messages.
 * 4. Global long-term memory summary maintenance.
 * 5. Per-conversation long-term summary maintenance.
 * 6. Token safety truncation (MEMORY_MAX_CONTEXT_CHARS).
 * 7. Memory-question detection for boosted global retrieval.
 */

import { PoolClient } from 'pg';
import { getClient, query, isDatabaseConnected, getDbPool } from './db';
import { getOrCreateConversation, getConversationByChatId, ConversationRow } from './conversations';
import { ConversationEntry } from '../types/whatsapp';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface LoadedContext {
  recentHistory: ConversationEntry[];
  summary: string | null;
  relevantOldMessages: ConversationEntry[];
  globalRelevantMessages: ConversationEntry[];
  globalSummary: string | null;
}

export interface SaveUserMessageParams {
  chatId: string;
  isGroup: boolean;
  messageId?: string;
  senderId?: string;
  content: string;
  sourceType: 'private' | 'group';
}

export interface SaveAssistantMessageParams {
  chatId: string;
  isGroup: boolean;
  content: string;
  modelUsed?: string;
  taskType?: string;
  memoryEligible?: boolean;
}

/** Legacy interface kept for backward compatibility in tests */
export interface SaveTurnParams {
  chatId: string;
  isGroup: boolean;
  userMessageId?: string;
  senderId?: string;
  userPrompt: string;
  assistantReply: string;
  modelUsed?: string;
  taskType?: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  message_id: string | null;
  sender_id: string | null;
  role: 'user' | 'assistant';
  content: string;
  model_used: string | null;
  task_type: string | null;
  memory_eligible: boolean;
  source_type: string;
  chat_id: string | null;
  created_at: Date;
}

export interface MemorySummaryRow {
  id: number;
  conversation_id: number;
  summary: string;
  message_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface GlobalMemoryRow {
  id: number;
  summary: string;
  message_count: number;
  created_at: Date;
  updated_at: Date;
}

// ─── Memory Question Detection ───────────────────────────────────────────────

const MEMORY_REFERENCE_PATTERNS = [
  /\b(ingat|masih\s+ingat|ingat\s+gak|ingat\s+ga|ingat\s+tidak)\b/i,
  /\b(sebelumnya|tadi|barusan|kemarin)\b/i,
  /\b(pernah\s+bilang|pernah\s+sebut|pernah\s+cerita)\b/i,
  /\b(kita\s+bahas\s+apa|apa\s+yang\s+dibahas)\b/i,
  /\b(siapa\s+yang\s+suka|dia\s+suka\s+siapa|suka\s+siapa)\b/i,
  /\b(siapa\s+namanya|apa\s+namanya|nama\s+siapa)\b/i,
  /\b(apa\s+project\s+kita|project\s+utama)\b/i,
  /\b(apa\s+yang\s+pernah\s+disebut|pernah\s+disebut)\b/i,
  /\b(dulu|waktu\s+itu|saat\s+itu)\b/i,
  /\b(ulang\s+tahun\s+kapan|kapan\s+ulang\s+tahun)\b/i,
];

/**
 * Detect if the user's prompt is referencing past memory/conversations.
 */
export function isMemoryQuestion(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().trim();
  return MEMORY_REFERENCE_PATTERNS.some((p) => p.test(normalized));
}

// ─── Recent History ──────────────────────────────────────────────────────────

/**
 * Retrieve recent history from messages table for a specific conversation.
 * Returns up to `limit` entries, ordered chronologically (oldest -> newest).
 */
export async function getRecentHistory(
  conversationId: number,
  limit: number,
  client?: PoolClient
): Promise<{ entries: ConversationEntry[]; messageIds: number[] }> {
  const sql = `
    SELECT id, role, content, created_at
    FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at DESC
    LIMIT $2;
  `;

  const res = client
    ? await client.query<Pick<MessageRow, 'id' | 'role' | 'content' | 'created_at'>>(sql, [conversationId, limit])
    : await query<Pick<MessageRow, 'id' | 'role' | 'content' | 'created_at'>>(sql, [conversationId, limit]);

  const rows = res.rows;
  // Reverse so oldest is first
  const chronological = [...rows].reverse();

  const entries: ConversationEntry[] = chronological.map((r) => ({
    role: r.role,
    content: r.content,
    timestamp: new Date(r.created_at).getTime(),
  }));

  const messageIds = rows.map((r) => r.id);

  return { entries, messageIds };
}

// ─── Per-Chat FTS ────────────────────────────────────────────────────────────

/**
 * Search old messages relevant to current prompt within a specific conversation using PostgreSQL FTS.
 * Excludes message IDs already present in recent history.
 */
export async function searchRelevantOldMessages(
  conversationId: number,
  prompt: string,
  excludeIds: number[],
  limit: number,
  client?: PoolClient
): Promise<ConversationEntry[]> {
  if (!prompt || !prompt.trim() || limit <= 0) return [];

  const cleanPrompt = prompt.replace(/[^\w\s\u00C0-\u017F]/g, ' ').trim();
  if (!cleanPrompt) return [];

  try {
    const hasExclude = excludeIds.length > 0;
    const sql = hasExclude
      ? `
        SELECT id, role, content, created_at,
               ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', $2)) AS rank
        FROM messages
        WHERE conversation_id = $1
          AND memory_eligible = true
          AND id != ALL($3::int[])
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $2)
        ORDER BY rank DESC, created_at DESC
        LIMIT $4;
      `
      : `
        SELECT id, role, content, created_at,
               ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', $2)) AS rank
        FROM messages
        WHERE conversation_id = $1
          AND memory_eligible = true
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $2)
        ORDER BY rank DESC, created_at DESC
        LIMIT $3;
      `;

    const params = hasExclude
      ? [conversationId, cleanPrompt, excludeIds, limit]
      : [conversationId, cleanPrompt, limit];

    const res = client
      ? await client.query<Pick<MessageRow, 'id' | 'role' | 'content' | 'created_at'>>(sql, params)
      : await query<Pick<MessageRow, 'id' | 'role' | 'content' | 'created_at'>>(sql, params);

    return res.rows.map((r) => ({
      role: r.role,
      content: r.content,
      timestamp: new Date(r.created_at).getTime(),
    }));
  } catch (err) {
    logger.database.warn('Relevant message search failed, skipping FTS:', (err as Error).message);
    return [];
  }
}

// ─── Global Cross-Chat FTS ───────────────────────────────────────────────────

/**
 * Search messages globally across ALL conversations using PostgreSQL FTS.
 * Excludes IDs already present in current chat recent history.
 * Used when GLOBAL_MEMORY_ENABLED=true and GLOBAL_MEMORY_CROSS_CHAT=true.
 */
export async function searchGlobalMessages(
  prompt: string,
  excludeIds: number[] = [],
  limit: number = config.globalMemoryRetrievalLimit,
  currentConversationId?: number,
  client?: PoolClient
): Promise<ConversationEntry[]> {
  if (!prompt || !prompt.trim() || limit <= 0) return [];
  if (!config.globalMemoryEnabled || !config.globalMemoryCrossChat) return [];

  const cleanPrompt = prompt.replace(/[^\w\s\u00C0-\u017F]/g, ' ').trim();
  if (!cleanPrompt) return [];

  try {
    const hasExclude = excludeIds.length > 0;

    // Exclude current conversation's messages to avoid duplicates with per-chat retrieval
    let sql: string;
    const params: any[] = [];

    if (hasExclude && currentConversationId) {
      sql = `
        SELECT id, role, content, created_at,
               ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', $1)) AS rank
        FROM messages
        WHERE memory_eligible = true
          AND conversation_id != $2
          AND id != ALL($3::int[])
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $1)
        ORDER BY rank DESC, created_at DESC
        LIMIT $4;
      `;
      params.push(cleanPrompt, currentConversationId, excludeIds, limit);
    } else if (currentConversationId) {
      sql = `
        SELECT id, role, content, created_at,
               ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', $1)) AS rank
        FROM messages
        WHERE memory_eligible = true
          AND conversation_id != $2
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $1)
        ORDER BY rank DESC, created_at DESC
        LIMIT $3;
      `;
      params.push(cleanPrompt, currentConversationId, limit);
    } else {
      sql = `
        SELECT id, role, content, created_at,
               ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', $1)) AS rank
        FROM messages
        WHERE memory_eligible = true
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $1)
        ORDER BY rank DESC, created_at DESC
        LIMIT $2;
      `;
      params.push(cleanPrompt, limit);
    }

    const res = client
      ? await client.query<Pick<MessageRow, 'id' | 'role' | 'content' | 'created_at'>>(sql, params)
      : await query<Pick<MessageRow, 'id' | 'role' | 'content' | 'created_at'>>(sql, params);

    return res.rows.map((r) => ({
      role: r.role,
      content: r.content,
      timestamp: new Date(r.created_at).getTime(),
    }));
  } catch (err) {
    logger.database.warn('Global message search failed, skipping global FTS:', (err as Error).message);
    return [];
  }
}

// ─── Per-Conversation Summary ────────────────────────────────────────────────

/**
 * Retrieve long-term memory summary for a conversation.
 */
export async function getConversationSummary(
  conversationId: number,
  client?: PoolClient
): Promise<{ summary: string; messageCount: number } | null> {
  const sql = `SELECT summary, message_count FROM conversation_memories WHERE conversation_id = $1 LIMIT 1;`;
  const res = client
    ? await client.query<Pick<MemorySummaryRow, 'summary' | 'message_count'>>(sql, [conversationId])
    : await query<Pick<MemorySummaryRow, 'summary' | 'message_count'>>(sql, [conversationId]);

  if (res.rows.length === 0) return null;
  return {
    summary: res.rows[0].summary,
    messageCount: res.rows[0].message_count,
  };
}

/**
 * Save or update long-term memory summary.
 */
export async function saveConversationSummary(
  conversationId: number,
  summary: string,
  messageCount: number,
  client?: PoolClient
): Promise<void> {
  const sql = `
    INSERT INTO conversation_memories (conversation_id, summary, message_count, updated_at)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (conversation_id) DO UPDATE
      SET summary = EXCLUDED.summary,
          message_count = EXCLUDED.message_count,
          updated_at = CURRENT_TIMESTAMP;
  `;

  if (client) {
    await client.query(sql, [conversationId, summary, messageCount]);
  } else {
    await query(sql, [conversationId, summary, messageCount]);
  }
}

// ─── Global Summary ──────────────────────────────────────────────────────────

/**
 * Retrieve the active global memory summary.
 */
export async function getGlobalSummary(
  client?: PoolClient
): Promise<{ summary: string; messageCount: number } | null> {
  const sql = `SELECT summary, message_count FROM global_memory ORDER BY updated_at DESC LIMIT 1;`;
  try {
    const res = client
      ? await client.query<Pick<GlobalMemoryRow, 'summary' | 'message_count'>>(sql)
      : await query<Pick<GlobalMemoryRow, 'summary' | 'message_count'>>(sql);

    if (res.rows.length === 0) return null;
    return {
      summary: res.rows[0].summary,
      messageCount: res.rows[0].message_count,
    };
  } catch (err) {
    logger.database.warn('Failed to load global summary:', (err as Error).message);
    return null;
  }
}

/**
 * Save or update the global memory summary (upsert on id=1 or insert new).
 */
export async function saveGlobalSummary(
  summary: string,
  messageCount: number,
  client?: PoolClient
): Promise<void> {
  // Upsert: if row exists, update; else insert
  const sql = `
    INSERT INTO global_memory (id, summary, message_count, updated_at)
    VALUES (1, $1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE
      SET summary = EXCLUDED.summary,
          message_count = EXCLUDED.message_count,
          updated_at = CURRENT_TIMESTAMP;
  `;
  if (client) {
    await client.query(sql, [summary, messageCount]);
  } else {
    await query(sql, [summary, messageCount]);
  }
}

/**
 * Get total count of memory-eligible messages globally.
 */
export async function getGlobalMessageCount(client?: PoolClient): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM messages WHERE memory_eligible = true;`;
  try {
    const res = client
      ? await client.query<{ count: string }>(sql)
      : await query<{ count: string }>(sql);
    return parseInt(res.rows[0].count, 10) || 0;
  } catch {
    return 0;
  }
}

// ─── Summary Builder ─────────────────────────────────────────────────────────

/**
 * Generate a concise factual summary of previous messages.
 */
export function buildFactualSummary(existingSummary: string | null, newMessages: ConversationEntry[]): string {
  const points: string[] = [];

  if (existingSummary && existingSummary.trim()) {
    points.push(existingSummary.trim());
  }

  // Extract key conversational context points
  const recentTopics = newMessages
    .filter((m) => m.role === 'user' && m.content.length > 5 && m.content.length < 200)
    .slice(-5)
    .map((m) => m.content.replace(/\s+/g, ' ').trim());

  if (recentTopics.length > 0) {
    points.push(`Topik sebelumnya: ${recentTopics.join('; ')}`);
  }

  // Ensure no sensitive keywords
  const combined = points.join('\n').replace(/(?:password|token|apikey|secret)[:=]\s*\S+/gi, '[REDACTED]');
  return combined.substring(0, 2000);
}

// ─── Individual Message Persistence ──────────────────────────────────────────

/**
 * Save a single user message to PostgreSQL.
 * Called BEFORE AI generation so messages persist even if AI fails.
 * Uses message_id for idempotency.
 */
export async function saveUserMessage(params: SaveUserMessageParams): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const conv = await getOrCreateConversation(
      params.chatId,
      params.isGroup ? 'group' : 'private',
      client
    );

    // Idempotency: skip if message_id already stored
    if (params.messageId) {
      const existing = await client.query(
        'SELECT id FROM messages WHERE message_id = $1 LIMIT 1;',
        [params.messageId]
      );
      if (existing.rows.length > 0) {
        logger.memory.info('[memory] duplicate user message skipped');
        await client.query('COMMIT');
        return;
      }
    }

    const sql = `
      INSERT INTO messages (conversation_id, chat_id, message_id, sender_id, role, content, source_type, memory_eligible, created_at)
      VALUES ($1, $2, $3, $4, 'user', $5, $6, true, CURRENT_TIMESTAMP)
      ON CONFLICT (message_id) DO NOTHING;
    `;
    await client.query(sql, [
      conv.id,
      params.chatId,
      params.messageId || null,
      params.senderId || null,
      params.content,
      params.sourceType,
    ]);

    // Update last_message_at
    await client.query(
      `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
      [conv.id]
    );

    await client.query('COMMIT');
    logger.memory.info('[memory] user-message persisted');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.database.warn('[memory] user-message persist failed:', (err as Error).message);
    // Do not re-throw: user message persistence failure should not block AI
  } finally {
    client.release();
  }
}

/**
 * Save a single assistant message to PostgreSQL.
 * Called AFTER AI generation succeeds and profanity filtering is applied.
 */
export async function saveAssistantMessage(params: SaveAssistantMessageParams): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const conv = await getOrCreateConversation(
      params.chatId,
      params.isGroup ? 'group' : 'private',
      client
    );

    const memoryEligible = params.memoryEligible !== undefined ? params.memoryEligible : true;

    const sql = `
      INSERT INTO messages (conversation_id, chat_id, role, content, model_used, task_type, source_type, memory_eligible, created_at)
      VALUES ($1, $2, 'assistant', $3, $4, $5, 'assistant', $6, CURRENT_TIMESTAMP);
    `;
    await client.query(sql, [
      conv.id,
      params.chatId,
      params.content,
      params.modelUsed || null,
      params.taskType || null,
      memoryEligible,
    ]);

    // Update last_message_at
    await client.query(
      `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
      [conv.id]
    );

    // Per-conversation summary update check
    if (config.memorySummaryEnabled) {
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM messages WHERE conversation_id = $1;`,
        [conv.id]
      );
      const totalMessages = parseInt(countRes.rows[0].count, 10) || 0;

      const summaryRecord = await getConversationSummary(conv.id, client);
      const lastSummaryCount = summaryRecord?.messageCount || 0;

      if (totalMessages - lastSummaryCount >= config.memorySummaryAfterMessages) {
        const { entries: messagesToSummarize } = await getRecentHistory(
          conv.id,
          config.memorySummaryKeepRecent,
          client
        );
        const newSummary = buildFactualSummary(summaryRecord?.summary || null, messagesToSummarize);
        await saveConversationSummary(conv.id, newSummary, totalMessages, client);
        logger.database.info(`long-term summary updated for conversation_id=${conv.id}`);
      }
    }

    await client.query('COMMIT');
    logger.memory.info('[memory] assistant-response persisted');

    // Global summary check (async, after commit, non-blocking)
    if (config.globalMemoryEnabled) {
      updateGlobalSummaryIfNeeded().catch((err) => {
        logger.database.warn('Global summary async update failed:', (err as Error).message);
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    logger.database.warn('[memory] assistant-message persist failed:', (err as Error).message);
    // Do not re-throw: assistant persistence failure should not break next messages
  } finally {
    client.release();
  }
}

/**
 * Legacy: Save user + assistant turn in a single atomic database transaction.
 * Kept for backward compatibility with existing tests.
 */
export async function saveSuccessfulTurn(params: SaveTurnParams): Promise<void> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const conv = await getOrCreateConversation(
      params.chatId,
      params.isGroup ? 'group' : 'private',
      client
    );

    // Insert user message (with optional message_id unique check)
    if (params.userMessageId) {
      const existing = await client.query(
        'SELECT id FROM messages WHERE message_id = $1 LIMIT 1;',
        [params.userMessageId]
      );
      if (existing.rows.length > 0) {
        logger.memory.info('[memory] duplicate message skipped');
        await client.query('COMMIT');
        return;
      }
    }

    const userInsertSql = `
      INSERT INTO messages (conversation_id, chat_id, message_id, sender_id, role, content, source_type, memory_eligible, created_at)
      VALUES ($1, $2, $3, $4, 'user', $5, $6, true, CURRENT_TIMESTAMP)
      ON CONFLICT (message_id) DO NOTHING;
    `;
    await client.query(userInsertSql, [
      conv.id,
      params.chatId,
      params.userMessageId || null,
      params.senderId || null,
      params.userPrompt,
      params.isGroup ? 'group' : 'private',
    ]);

    // Insert assistant message
    const assistantInsertSql = `
      INSERT INTO messages (conversation_id, chat_id, role, content, model_used, task_type, source_type, memory_eligible, created_at)
      VALUES ($1, $2, 'assistant', $3, $4, $5, 'assistant', true, CURRENT_TIMESTAMP);
    `;
    await client.query(assistantInsertSql, [
      conv.id,
      params.chatId,
      params.assistantReply,
      params.modelUsed || null,
      params.taskType || null,
    ]);

    // Update last_message_at
    await client.query(
      `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
      [conv.id]
    );

    // Update summary if threshold reached
    if (config.memorySummaryEnabled) {
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM messages WHERE conversation_id = $1;`,
        [conv.id]
      );
      const totalMessages = parseInt(countRes.rows[0].count, 10) || 0;

      const summaryRecord = await getConversationSummary(conv.id, client);
      const lastSummaryCount = summaryRecord?.messageCount || 0;

      if (totalMessages - lastSummaryCount >= config.memorySummaryAfterMessages) {
        const { entries: messagesToSummarize } = await getRecentHistory(
          conv.id,
          config.memorySummaryKeepRecent,
          client
        );
        const newSummary = buildFactualSummary(summaryRecord?.summary || null, messagesToSummarize);
        await saveConversationSummary(conv.id, newSummary, totalMessages, client);
        logger.database.info(`long-term summary updated for conversation_id=${conv.id}`);
      }
    }

    await client.query('COMMIT');
    logger.database.info('turn transaction committed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.database.error('Transaction rolled back on error:', (err as Error).message);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Global Summary Update ───────────────────────────────────────────────────

/**
 * Check if global summary needs updating and rebuild if threshold reached.
 * Non-blocking; called after assistant message is committed.
 */
export async function updateGlobalSummaryIfNeeded(): Promise<void> {
  if (!config.globalMemoryEnabled) return;

  try {
    const totalMessages = await getGlobalMessageCount();
    const existing = await getGlobalSummary();
    const lastCount = existing?.messageCount || 0;

    if (totalMessages - lastCount >= config.globalMemorySummaryAfterMessages) {
      // Fetch recent global messages to summarize
      const sql = `
        SELECT role, content, created_at
        FROM messages
        WHERE memory_eligible = true
        ORDER BY created_at DESC
        LIMIT $1;
      `;
      const res = await query<Pick<MessageRow, 'role' | 'content' | 'created_at'>>(sql, [
        config.globalMemorySummaryKeepRecent,
      ]);

      const recentMessages: ConversationEntry[] = [...res.rows].reverse().map((r) => ({
        role: r.role,
        content: r.content,
        timestamp: new Date(r.created_at).getTime(),
      }));

      const newSummary = buildFactualSummary(existing?.summary || null, recentMessages);
      await saveGlobalSummary(newSummary, totalMessages);
      logger.database.info(`global summary updated at count=${totalMessages}`);
    }
  } catch (err) {
    logger.database.warn('Global summary update failed:', (err as Error).message);
  }
}

// ─── Context Loading ─────────────────────────────────────────────────────────

/**
 * Load complete conversation context for AI generation.
 * Handles:
 * - Recent history (per-chat)
 * - Per-chat summary
 * - Per-chat relevant old messages via FTS
 * - Global cross-chat relevant messages via FTS (if enabled)
 * - Global summary (if enabled)
 * - Token safety truncation
 */
export async function loadConversationContext(
  chatId: string,
  currentPrompt: string
): Promise<LoadedContext> {
  if (!getDbPool()) {
    return {
      recentHistory: [],
      summary: null,
      relevantOldMessages: [],
      globalRelevantMessages: [],
      globalSummary: null,
    };
  }

  try {
    const conv = await getConversationByChatId(chatId);
    if (!conv) {
      // No conversation yet; still try global memory
      let globalRelevantMessages: ConversationEntry[] = [];
      let globalSummary: string | null = null;

      if (config.globalMemoryEnabled && config.globalMemoryCrossChat) {
        const memQuestion = isMemoryQuestion(currentPrompt);
        const globalLimit = memQuestion
          ? config.globalMemoryRetrievalLimit * 2
          : config.globalMemoryRetrievalLimit;

        globalRelevantMessages = await searchGlobalMessages(
          currentPrompt, [], globalLimit
        );
        const globalSummaryRecord = await getGlobalSummary();
        globalSummary = globalSummaryRecord?.summary || null;
      }

      return {
        recentHistory: [],
        summary: null,
        relevantOldMessages: [],
        globalRelevantMessages,
        globalSummary,
      };
    }

    // 1. Fetch recent history
    const { entries: rawRecentHistory, messageIds: recentIds } = await getRecentHistory(
      conv.id,
      config.maxHistoryMessages
    );

    // If the most recent message is the current user prompt that was just inserted before AI call,
    // exclude it from previous history so it is not duplicated in prompt context.
    const recentHistory = [...rawRecentHistory];
    if (
      recentHistory.length > 0 &&
      recentHistory[recentHistory.length - 1].role === 'user' &&
      recentHistory[recentHistory.length - 1].content === currentPrompt
    ) {
      recentHistory.pop();
    }

    logger.database.info(`history loaded count=${recentHistory.length}`);

    // 2. Fetch per-chat summary if enabled
    let summary: string | null = null;
    if (config.memorySummaryEnabled) {
      const summaryRecord = await getConversationSummary(conv.id);
      summary = summaryRecord?.summary || null;
    }

    // 3. Search per-chat relevant old messages if enabled
    let relevantOldMessages: ConversationEntry[] = [];
    if (config.memoryRetrievalEnabled) {
      relevantOldMessages = await searchRelevantOldMessages(
        conv.id,
        currentPrompt,
        recentIds,
        config.memoryRetrievalLimit
      );
    }

    // 4. Search global cross-chat relevant messages if enabled
    let globalRelevantMessages: ConversationEntry[] = [];
    let globalSummary: string | null = null;

    if (config.globalMemoryEnabled && config.globalMemoryCrossChat) {
      const memQuestion = isMemoryQuestion(currentPrompt);
      const globalLimit = memQuestion
        ? config.globalMemoryRetrievalLimit * 2
        : config.globalMemoryRetrievalLimit;

      globalRelevantMessages = await searchGlobalMessages(
        currentPrompt,
        recentIds,
        globalLimit,
        conv.id
      );

      const globalSummaryRecord = await getGlobalSummary();
      globalSummary = globalSummaryRecord?.summary || null;
    }

    // 5. Token safety truncation (MEMORY_MAX_CONTEXT_CHARS)
    const maxChars = config.memoryMaxContextChars;
    let totalChars =
      currentPrompt.length +
      (summary ? summary.length : 0) +
      (globalSummary ? globalSummary.length : 0) +
      recentHistory.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) +
      relevantOldMessages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) +
      globalRelevantMessages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);

    // If context exceeds limit, progressively drop:
    // 1. Drop global relevant messages first
    if (totalChars > maxChars && globalRelevantMessages.length > 0) {
      totalChars -= globalRelevantMessages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
      globalRelevantMessages = [];
    }

    // 2. Drop per-chat relevant old messages
    if (totalChars > maxChars && relevantOldMessages.length > 0) {
      totalChars -= relevantOldMessages.reduce((acc, m) => acc + m.content.length, 0);
      relevantOldMessages = [];
    }

    // 3. Truncate global summary
    if (totalChars > maxChars && globalSummary) {
      totalChars -= globalSummary.length;
      globalSummary = null;
    }

    // 4. Truncate per-chat summary
    if (totalChars > maxChars && summary) {
      const excess = totalChars - maxChars;
      if (summary.length > excess + 100) {
        summary = summary.substring(0, summary.length - excess) + '...';
      } else {
        summary = null;
      }
    }

    logger.memory.info(
      `[memory] global-relevant=${globalRelevantMessages.length} current-chat=${recentHistory.length}`
    );

    return {
      recentHistory,
      summary,
      relevantOldMessages,
      globalRelevantMessages,
      globalSummary,
    };
  } catch (err) {
    logger.database.warn('Failed to load conversation context from DB, using empty context:', (err as Error).message);
    return {
      recentHistory: [],
      summary: null,
      relevantOldMessages: [],
      globalRelevantMessages: [],
      globalSummary: null,
    };
  }
}
