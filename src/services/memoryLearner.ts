/**
 * Background Asynchronous Memory Learner.
 *
 * Extracts durable factual knowledge from user conversations in the background.
 * Uses an asynchronous queue (memory_ingest_queue) and small batches.
 * Assistant messages are strictly ignored for fact extraction to prevent hallucination loops.
 */

import { query, getDbPool } from '../database/db';
import { config, getVpsmurahAiApiKey } from '../config';
import { saveLearnedFact } from '../database/factsRepository';
import { exportKnowledgeTextSnapshot, recordNewInformationFact } from './knowledgeSnapshot';
import { logger } from '../utils/logger';
import { getOpenAIClient } from './aiService';

export interface IngestQueueItem {
  id: number;
  messageId: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attemptCount: number;
  lastError: string | null;
  createdAt: Date;
}

export interface LearnerFactItem {
  subject?: string;
  predicate?: string;
  object?: string;
  factText: string;
  confidence?: number;
}

export interface LearnerResponse {
  hasNewInformation: boolean;
  facts: LearnerFactItem[];
}

// Diagnostics state
let learnerPendingCount = 0;
let learnerProcessingCount = 0;
let learnerFailedCount = 0;
let lastMemoryLearnAt: string | null = null;
let lastLearnedFactCount = 0;

// Test override handler
let testLearnerHandler: ((messageText: string) => Promise<LearnerResponse | null>) | null = null;

export function setTestLearnerHandler(
  handler: ((messageText: string) => Promise<LearnerResponse | null>) | null
): void {
  testLearnerHandler = handler;
}

// In-memory queue fallback for tests and DB-offline mode
interface InMemoryQueueItem {
  messageId: string;
  role: string;
  content: string;
  chatId: string;
  senderId?: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attemptCount: number;
  nextRetryAt: number;
}
const inMemoryQueue: InMemoryQueueItem[] = [];

/**
 * Enqueue a message into the background memory learning queue.
 */
export async function enqueueMessageForLearning(params: {
  messageId: string;
  role: string;
  content: string;
  chatId: string;
  senderId?: string;
}): Promise<void> {
  if (!config.memoryLearnerEnabled || !params.messageId) return;

  // Always track in-memory queue item
  inMemoryQueue.push({
    messageId: params.messageId,
    role: params.role,
    content: params.content,
    chatId: params.chatId,
    senderId: params.senderId,
    status: 'pending',
    attemptCount: 0,
    nextRetryAt: Date.now(),
  });

  if (getDbPool()) {
    try {
      const sql = `
        INSERT INTO memory_ingest_queue (message_id, status, attempt_count, created_at)
        VALUES ($1, 'pending', 0, CURRENT_TIMESTAMP)
        ON CONFLICT (message_id) DO NOTHING;
      `;
      await query(sql, [params.messageId]);
    } catch (err) {
      logger.database.warn('Failed to enqueue into PostgreSQL memory_ingest_queue:', (err as Error).message);
    }
  }
}

/**
 * Call the AI model to extract factual knowledge as strict JSON.
 */
async function callLearnerModel(text: string): Promise<LearnerResponse | null> {
  if (testLearnerHandler) {
    return testLearnerHandler(text);
  }

  const prompt = `Analisis pesan percakapan berikut. Apakah ada informasi baru yang faktual dan tahan lama (nama, orang, preferensi, proyek, jadwal, tempat, relasi, fakta)?
Jangan berasumsi atau mengarang informasi di luar yang tertulis.
Kembalikan respon DALAM FORMAT JSON KETAT (valid JSON saja tanpa markdown/backticks):
{
  "hasNewInformation": true,
  "facts": [
    {
      "subject": "nama subjek atau topik",
      "predicate": "predikat atau hubungan",
      "object": "objek atau detail",
      "factText": "kalimat fakta ringkas dan jelas",
      "confidence": 0.9
    }
  ]
}
Jika tidak ada informasi faktual baru, kembalikan:
{"hasNewInformation": false, "facts": []}

Pesan: "${text.replace(/"/g, '\\"')}"`;

  const primaryModel = config.memoryLearnerModel || 'gemini-38';
  const fallbackModel = config.memoryLearnerFallbackModel || 'qwen3-flash';

  const models = [primaryModel, fallbackModel];

  for (const model of models) {
    try {
      const client = getOpenAIClient();
      const completion = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const raw = completion.choices?.[0]?.message?.content || '';
      const cleanJson = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.facts)) {
        return parsed as LearnerResponse;
      }
    } catch {
      // try next model
    }
  }

  return null;
}

/**
 * Process a single learning batch.
 */
export async function processLearnerBatch(): Promise<number> {
  if (!config.memoryLearnerEnabled) return 0;

  let processedCount = 0;
  let newFactsInBatch = 0;

  // 1. Process in-memory queue items
  const now = Date.now();
  const eligibleMemItems = inMemoryQueue.filter(
    (item) => (item.status === 'pending' || (item.status === 'failed' && item.attemptCount < config.memoryLearnerMaxRetries && item.nextRetryAt <= now))
  ).slice(0, config.memoryLearnerBatchSize);

  for (const item of eligibleMemItems) {
    // CRITICAL: Assistant messages are NEVER learned as facts (avoids hallucination loops)
    if (item.role !== 'user') {
      item.status = 'done';
      continue;
    }

    item.status = 'processing';
    item.attemptCount++;

    try {
      const result = await callLearnerModel(item.content);
      if (result && result.hasNewInformation && Array.isArray(result.facts)) {
        for (const f of result.facts) {
          if (!f.factText) continue;
          const saveRes = await saveLearnedFact({
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            factText: f.factText,
            sourceMessageId: item.messageId,
            sourceChatId: item.chatId,
            sourceSenderId: item.senderId,
            confidence: f.confidence,
          });

          if (saveRes.inserted) {
            newFactsInBatch++;
            await recordNewInformationFact(f.factText);
          }
        }
      }

      item.status = 'done';
      processedCount++;
    } catch (err) {
      if (item.attemptCount >= config.memoryLearnerMaxRetries) {
        item.status = 'failed';
      } else {
        item.status = 'pending';
        item.nextRetryAt = Date.now() + Math.pow(2, item.attemptCount) * 1000;
      }
      logger.memory.warn(`Memory learner item failed (attempt ${item.attemptCount}): ${(err as Error).message}`);
    }
  }

  // 2. Also process DB queue if available
  if (getDbPool()) {
    try {
      const fetchSql = `
        SELECT q.id, q.message_id, q.attempt_count, m.role, m.content, m.chat_id, m.sender_id
        FROM memory_ingest_queue q
        LEFT JOIN messages m ON q.message_id = m.message_id
        WHERE q.status = 'pending'
           OR (q.status = 'failed' AND q.attempt_count < $1 AND (q.next_retry_at IS NULL OR q.next_retry_at <= CURRENT_TIMESTAMP))
        ORDER BY q.created_at ASC
        LIMIT $2;
      `;
      const res = await query(fetchSql, [config.memoryLearnerMaxRetries, config.memoryLearnerBatchSize]);

      for (const row of res.rows) {
        // Guard: only user messages are factual
        if (row.role && row.role !== 'user') {
          await query(`UPDATE memory_ingest_queue SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = $1;`, [row.id]);
          continue;
        }

        if (!row.content) {
          await query(`UPDATE memory_ingest_queue SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = $1;`, [row.id]);
          continue;
        }

        await query(`UPDATE memory_ingest_queue SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP WHERE id = $1;`, [row.id]);

        try {
          const result = await callLearnerModel(row.content);
          if (result && result.hasNewInformation && Array.isArray(result.facts)) {
            for (const f of result.facts) {
              if (!f.factText) continue;
              const saveRes = await saveLearnedFact({
                subject: f.subject,
                predicate: f.predicate,
                object: f.object,
                factText: f.factText,
                sourceMessageId: row.message_id,
                sourceChatId: row.chat_id,
                sourceSenderId: row.sender_id,
                confidence: f.confidence,
              });

              if (saveRes.inserted) {
                newFactsInBatch++;
                await recordNewInformationFact(f.factText);
              }
            }
          }

          await query(`UPDATE memory_ingest_queue SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = $1;`, [row.id]);
          processedCount++;
        } catch (jobErr) {
          const nextAttempt = (row.attempt_count || 0) + 1;
          const status = nextAttempt >= config.memoryLearnerMaxRetries ? 'failed' : 'pending';
          const backoffSec = Math.pow(2, nextAttempt) * 2;
          await query(
            `UPDATE memory_ingest_queue
             SET status = $1, attempt_count = $2, last_error = $3,
                 next_retry_at = CURRENT_TIMESTAMP + ($4 || ' seconds')::interval
             WHERE id = $5;`,
            [status, nextAttempt, (jobErr as Error).message, backoffSec, row.id]
          );
        }
      }
    } catch (dbErr) {
      logger.memory.warn('Failed to query DB memory_ingest_queue:', (dbErr as Error).message);
    }
  }

  if (newFactsInBatch > 0) {
    lastLearnedFactCount = newFactsInBatch;
    lastMemoryLearnAt = new Date().toISOString();
    await exportKnowledgeTextSnapshot();
    logger.memory.info(`[memory] learned new facts=${newFactsInBatch} batch_processed=${processedCount}`);
  }

  return processedCount;
}

// Worker Timer
let workerTimer: NodeJS.Timeout | null = null;
let isWorkerRunning = false;

/**
 * Start periodic background memory learner worker.
 */
export function startMemoryLearnerWorker(): void {
  if (workerTimer || !config.memoryLearnerEnabled) return;

  const intervalMs = config.memoryLearnerIntervalMs || 5000;
  workerTimer = setInterval(async () => {
    if (isWorkerRunning) return;
    isWorkerRunning = true;
    try {
      await processLearnerBatch();
    } catch (err) {
      logger.memory.warn('Memory learner worker iteration error:', (err as Error).message);
    } finally {
      isWorkerRunning = false;
    }
  }, intervalMs);

  if (typeof workerTimer.unref === 'function') {
    workerTimer.unref();
  }
}

/**
 * Stop background memory learner worker.
 */
export function stopMemoryLearnerWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  isWorkerRunning = false;
}

/**
 * Get memory learner diagnostics for /admin/status.
 */
export function getLearnerDiagnostics(): {
  memoryLearnerEnabled: boolean;
  memoryLearnerPending: number;
  memoryLearnerProcessing: number;
  memoryLearnerFailed: number;
  lastMemoryLearnAt: string | null;
  lastLearnedFactCount: number;
} {
  const pending = inMemoryQueue.filter((i) => i.status === 'pending').length;
  const processing = inMemoryQueue.filter((i) => i.status === 'processing').length;
  const failed = inMemoryQueue.filter((i) => i.status === 'failed').length;

  return {
    memoryLearnerEnabled: config.memoryLearnerEnabled,
    memoryLearnerPending: pending,
    memoryLearnerProcessing: processing,
    memoryLearnerFailed: failed,
    lastMemoryLearnAt,
    lastLearnedFactCount,
  };
}

/**
 * Reset memory learner state (for unit tests).
 */
export function resetMemoryLearnerState(): void {
  inMemoryQueue.length = 0;
  testLearnerHandler = null;
  lastMemoryLearnAt = null;
  lastLearnedFactCount = 0;
}
