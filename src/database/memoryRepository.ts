/**
 * PostgreSQL Memory Repository.
 *
 * Implements:
 * 1. Transactional save of successful user + assistant conversation turns.
 * 2. Retrieval of recent history (chronological oldest -> newest).
 * 3. PostgreSQL Full-Text Search for old relevant messages with deduplication against recent history.
 * 4. Long-term memory summary maintenance and storage.
 * 5. Token safety truncation (MEMORY_MAX_CONTEXT_CHARS=12000).
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
}

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

/**
 * Retrieve recent history from messages table.
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

/**
 * Search old messages relevant to current prompt using PostgreSQL Full-Text Search.
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

  // Clean prompt for search query (remove special characters that break plainto_tsquery)
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
  return combined.substring(0, 1500);
}

/**
 * Load complete conversation context for AI generation.
 * Handles recent history, summary, relevant old messages, and token safety truncation.
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
    };
  }

  try {
    const conv = await getConversationByChatId(chatId);
    if (!conv) {
      return {
        recentHistory: [],
        summary: null,
        relevantOldMessages: [],
      };
    }

    // 1. Fetch recent history
    const { entries: recentHistory, messageIds: recentIds } = await getRecentHistory(
      conv.id,
      config.maxHistoryMessages
    );

    logger.database.info(`history loaded count=${recentHistory.length}`);

    // 2. Fetch summary if enabled
    let summary: string | null = null;
    if (config.memorySummaryEnabled) {
      const summaryRecord = await getConversationSummary(conv.id);
      summary = summaryRecord?.summary || null;
    }

    // 3. Search relevant old messages if enabled
    let relevantOldMessages: ConversationEntry[] = [];
    if (config.memoryRetrievalEnabled) {
      relevantOldMessages = await searchRelevantOldMessages(
        conv.id,
        currentPrompt,
        recentIds,
        config.memoryRetrievalLimit
      );
    }

    // 4. Token safety truncation (MEMORY_MAX_CONTEXT_CHARS)
    const maxChars = config.memoryMaxContextChars;
    let totalChars =
      currentPrompt.length +
      (summary ? summary.length : 0) +
      recentHistory.reduce((acc, m) => acc + m.content.length, 0) +
      relevantOldMessages.reduce((acc, m) => acc + m.content.length, 0);

    // If context exceeds limit, drop relevant old messages first
    if (totalChars > maxChars && relevantOldMessages.length > 0) {
      relevantOldMessages = [];
      totalChars =
        currentPrompt.length +
        (summary ? summary.length : 0) +
        recentHistory.reduce((acc, m) => acc + m.content.length, 0);
    }

    // If still exceeds limit, truncate summary
    if (totalChars > maxChars && summary) {
      const excess = totalChars - maxChars;
      if (summary.length > excess + 100) {
        summary = summary.substring(0, summary.length - excess) + '...';
      } else {
        summary = null;
      }
    }

    return {
      recentHistory,
      summary,
      relevantOldMessages,
    };
  } catch (err) {
    logger.database.warn('Failed to load conversation context from DB, using empty context:', (err as Error).message);
    return {
      recentHistory: [],
      summary: null,
      relevantOldMessages: [],
    };
  }
}

/**
 * Save user + assistant turn in a single atomic database transaction.
 */
export async function saveSuccessfulTurn(params: SaveTurnParams): Promise<void> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Get or create conversation record
    const conv = await getOrCreateConversation(
      params.chatId,
      params.isGroup ? 'group' : 'private',
      client
    );

    // 2. Insert user message (with optional message_id unique check)
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
      INSERT INTO messages (conversation_id, message_id, sender_id, role, content, created_at)
      VALUES ($1, $2, $3, 'user', $4, CURRENT_TIMESTAMP)
      ON CONFLICT (message_id) DO NOTHING;
    `;
    await client.query(userInsertSql, [
      conv.id,
      params.userMessageId || null,
      params.senderId || null,
      params.userPrompt,
    ]);

    // 3. Insert assistant message
    const assistantInsertSql = `
      INSERT INTO messages (conversation_id, role, content, model_used, task_type, created_at)
      VALUES ($1, 'assistant', $2, $3, $4, CURRENT_TIMESTAMP);
    `;
    await client.query(assistantInsertSql, [
      conv.id,
      params.assistantReply,
      params.modelUsed || null,
      params.taskType || null,
    ]);

    // 4. Update last_message_at
    await client.query(
      `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
      [conv.id]
    );

    // 5. Update summary if threshold reached
    if (config.memorySummaryEnabled) {
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM messages WHERE conversation_id = $1;`,
        [conv.id]
      );
      const totalMessages = parseInt(countRes.rows[0].count, 10) || 0;

      const summaryRecord = await getConversationSummary(conv.id, client);
      const lastSummaryCount = summaryRecord?.messageCount || 0;

      if (totalMessages - lastSummaryCount >= config.memorySummaryAfterMessages) {
        // Fetch recent messages to summarize
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
