/**
 * Conversations Repository.
 *
 * Handles creation, retrieval, and deletion of conversation records.
 */

import { PoolClient } from 'pg';
import { query } from './db';
import { logger } from '../utils/logger';

export interface ConversationRow {
  id: number;
  chat_id: string;
  chat_type: 'private' | 'group';
  created_at: Date;
  updated_at: Date;
  last_message_at: Date;
}

/**
 * Get or create a conversation record by chat_id.
 */
export async function getOrCreateConversation(
  chatId: string,
  chatType: 'private' | 'group',
  client?: PoolClient
): Promise<ConversationRow> {
  const sql = `
    INSERT INTO conversations (chat_id, chat_type, updated_at, last_message_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (chat_id) DO UPDATE
      SET updated_at = CURRENT_TIMESTAMP
    RETURNING id, chat_id, chat_type, created_at, updated_at, last_message_at;
  `;

  if (client) {
    const res = await client.query<ConversationRow>(sql, [chatId, chatType]);
    return res.rows[0];
  } else {
    const res = await query<ConversationRow>(sql, [chatId, chatType]);
    return res.rows[0];
  }
}

/**
 * Find conversation by chat_id.
 */
export async function getConversationByChatId(
  chatId: string,
  client?: PoolClient
): Promise<ConversationRow | null> {
  const sql = `SELECT id, chat_id, chat_type, created_at, updated_at, last_message_at FROM conversations WHERE chat_id = $1 LIMIT 1;`;
  const res = client ? await client.query<ConversationRow>(sql, [chatId]) : await query<ConversationRow>(sql, [chatId]);
  return res.rows[0] || null;
}

/**
 * Update last_message_at for a conversation.
 */
export async function updateConversationLastMessage(
  conversationId: number,
  client?: PoolClient
): Promise<void> {
  const sql = `UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`;
  if (client) {
    await client.query(sql, [conversationId]);
  } else {
    await query(sql, [conversationId]);
  }
}

/**
 * Delete a single conversation and its cascading messages & summary.
 */
export async function deleteConversation(chatId: string): Promise<boolean> {
  const sql = `DELETE FROM conversations WHERE chat_id = $1 RETURNING id;`;
  const res = await query(sql, [chatId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Delete all conversations and all cascading data.
 */
export async function deleteAllConversations(): Promise<number> {
  const sql = `DELETE FROM conversations;`;
  const res = await query(sql);
  return res.rowCount ?? 0;
}
