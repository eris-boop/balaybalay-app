/**
 * Persistent Database Fallback Spool.
 *
 * When PostgreSQL is degraded or unavailable, incoming messages and turns
 * are spooled as JSONL to disk (/app/data/db-spool/messages.jsonl).
 * When PostgreSQL becomes healthy, the spool is safely replayed and compacted.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { config } from '../config';
import { logger } from '../utils/logger';
import { query } from '../database/db';
import { getOrCreateConversation } from '../database/conversations';

export interface SpoolMessageEvent {
  eventId: string;
  type: 'user_message' | 'assistant_message';
  chatId: string;
  isGroup: boolean;
  messageId?: string;
  senderId?: string;
  content: string;
  sourceType: 'private' | 'group' | 'assistant';
  replyToMessageId?: string;
  modelUsed?: string;
  taskType?: string;
  timestamp: number;
}

let isReplaying = false;

function ensureSpoolDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Spool an event to the persistent JSONL file.
 */
export async function spoolMessage(event: SpoolMessageEvent): Promise<void> {
  if (!config.dbSpoolEnabled) return;

  const spoolPath = path.resolve(config.dbSpoolPath);
  ensureSpoolDir(spoolPath);

  const line = JSON.stringify(event) + '\n';
  await fs.promises.appendFile(spoolPath, line, 'utf-8');
  logger.database.info(`[db] spooled event type=${event.type} messageId=${event.messageId || event.eventId}`);
}

/**
 * Count how many pending events exist in the spool file.
 */
export function getSpoolPendingCount(): number {
  if (!config.dbSpoolEnabled) return 0;
  const spoolPath = path.resolve(config.dbSpoolPath);
  if (!fs.existsSync(spoolPath)) return 0;

  try {
    const data = fs.readFileSync(spoolPath, 'utf-8');
    const lines = data.split('\n').filter((l) => l.trim().length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

/**
 * Replay unsynced spool events into PostgreSQL.
 * Safe, idempotent replay: ON CONFLICT (message_id) DO NOTHING.
 */
export async function replaySpool(): Promise<number> {
  if (!config.dbSpoolEnabled || isReplaying) return 0;
  const spoolPath = path.resolve(config.dbSpoolPath);
  if (!fs.existsSync(spoolPath)) return 0;

  isReplaying = true;
  let replayedCount = 0;
  const failedEvents: SpoolMessageEvent[] = [];

  try {
    const fileStream = fs.createReadStream(spoolPath, 'utf-8');
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let event: SpoolMessageEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      try {
        const conv = await getOrCreateConversation(
          event.chatId,
          event.isGroup ? 'group' : 'private'
        );

        if (event.type === 'user_message') {
          const sql = `
            INSERT INTO messages (
              conversation_id, chat_id, message_id, sender_id, role,
              content, source_type, reply_to_message_id, memory_eligible, learn_status, created_at
            )
            VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, true, 'pending', CURRENT_TIMESTAMP)
            ON CONFLICT (message_id) DO NOTHING;
          `;
          await query(sql, [
            conv.id,
            event.chatId,
            event.messageId || null,
            event.senderId || null,
            event.content,
            event.sourceType || (event.isGroup ? 'group' : 'private'),
            event.replyToMessageId || null,
          ]);

          if (event.messageId) {
            await query(
              `INSERT INTO memory_ingest_queue (message_id, status)
               VALUES ($1, 'pending')
               ON CONFLICT (message_id) DO NOTHING;`,
              [event.messageId]
            ).catch(() => {});
          }
        } else if (event.type === 'assistant_message') {
          const sql = `
            INSERT INTO messages (
              conversation_id, chat_id, role, content, model_used,
              task_type, source_type, memory_eligible, learn_status, created_at
            )
            VALUES ($1, $2, 'assistant', $3, $4, $5, 'assistant', false, 'skipped', CURRENT_TIMESTAMP);
          `;
          await query(sql, [
            conv.id,
            event.chatId,
            event.content,
            event.modelUsed || null,
            event.taskType || null,
          ]);
        }

        replayedCount++;
      } catch (err) {
        logger.database.warn('Failed to replay spooled event, retaining in spool:', (err as Error).message);
        failedEvents.push(event);
      }
    }

    // Atomically rewrite spool file with any remaining failed events (compaction)
    if (failedEvents.length === 0) {
      if (fs.existsSync(spoolPath)) {
        await fs.promises.unlink(spoolPath);
      }
    } else {
      const tempPath = `${spoolPath}.tmp_${Date.now()}`;
      const newContent = failedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.promises.writeFile(tempPath, newContent, 'utf-8');
      await fs.promises.rename(tempPath, spoolPath);
    }

    if (replayedCount > 0) {
      logger.database.info(`[db] replayed events=${replayedCount}`);
    }
  } catch (err) {
    logger.database.warn('Spool replay error:', (err as Error).message);
  } finally {
    isReplaying = false;
  }

  return replayedCount;
}

/**
 * Clear spool file (for testing purposes).
 */
export function clearSpool(): void {
  const spoolPath = path.resolve(config.dbSpoolPath);
  if (fs.existsSync(spoolPath)) {
    try {
      fs.unlinkSync(spoolPath);
    } catch {
      // ignore
    }
  }
}
