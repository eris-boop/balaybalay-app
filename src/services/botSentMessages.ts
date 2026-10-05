/**
 * Bot Sent Messages Tracker.
 *
 * Tracks messages sent by the bot across restarts to reliably detect
 * when a user in a group chat quotes/replies to a bot message without @mentioning.
 */

import { query, getDbPool } from '../database/db';
import { logger } from '../utils/logger';

// In-memory set cache for instant sub-millisecond lookup and offline/test resilience
const botSentCache = new Set<string>();

/**
 * Record a message sent by the bot.
 */
export async function recordBotSentMessage(messageId: string, chatId: string): Promise<void> {
  if (!messageId) return;

  botSentCache.add(messageId);

  // Bound in-memory cache size
  if (botSentCache.size > 5000) {
    const firstKey = botSentCache.values().next().value;
    if (firstKey) botSentCache.delete(firstKey);
  }

  if (getDbPool()) {
    try {
      const sql = `
        INSERT INTO bot_sent_messages (whatsapp_message_id, chat_id, created_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (whatsapp_message_id) DO NOTHING;
      `;
      await query(sql, [messageId, chatId]);
    } catch (err) {
      logger.database.warn('Failed to record bot sent message to database (in-memory cached):', (err as Error).message);
    }
  }
}

/**
 * Check if a WhatsApp message ID was originally sent by this bot.
 */
export async function isBotSentMessage(messageId?: string | null): Promise<boolean> {
  if (!messageId) return false;

  // 1. Check in-memory cache first
  if (botSentCache.has(messageId)) {
    return true;
  }

  // 2. Query persistent PostgreSQL
  if (getDbPool()) {
    try {
      const sql = `
        SELECT id FROM bot_sent_messages
        WHERE whatsapp_message_id = $1
        LIMIT 1;
      `;
      const res = await query(sql, [messageId]);
      if (res.rows.length > 0) {
        botSentCache.add(messageId);
        return true;
      }
    } catch (err) {
      logger.database.warn('Database query for bot_sent_messages failed:', (err as Error).message);
    }
  }

  return false;
}

/**
 * Reset cache for testing.
 */
export function clearBotSentCache(): void {
  botSentCache.clear();
}
