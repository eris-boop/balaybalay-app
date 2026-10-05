/**
 * Memory Facts Repository.
 *
 * Manages durable learned factual knowledge stored in PostgreSQL `memory_facts`.
 * Supports full-text search, ILIKE phrase fallback, deduplication via SHA-256 fingerprinting,
 * contradiction resolution (superseded / disputed), and in-memory fallback for test environments.
 */

import crypto from 'crypto';
import { PoolClient } from 'pg';
import { query, getClient, getDbPool } from './db';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface MemoryFact {
  id: number;
  factKey?: string | null;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  factText: string;
  normalizedFact: string;
  sourceMessageId?: string | null;
  sourceChatId?: string | null;
  sourceSenderId?: string | null;
  sourceRole?: string;
  confidence: number;
  status: 'active' | 'superseded' | 'disputed';
  fingerprint: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFactInput {
  subject?: string;
  predicate?: string;
  object?: string;
  factText: string;
  sourceMessageId?: string;
  sourceChatId?: string;
  sourceSenderId?: string;
  sourceRole?: string;
  confidence?: number;
}

// In-memory fallback for unit tests or when PostgreSQL is offline
const inMemoryFacts: MemoryFact[] = [];
let inMemoryFactId = 1;

/**
 * Normalize text for fingerprinting and searching.
 */
export function normalizeFactString(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u017F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a deterministic fingerprint from subject, predicate, and object (or factText).
 */
export function generateFactFingerprint(input: {
  subject?: string;
  predicate?: string;
  object?: string;
  factText: string;
}): string {
  const normSub = normalizeFactString(input.subject || '');
  const normPred = normalizeFactString(input.predicate || '');
  const normObj = normalizeFactString(input.object || '');

  let raw = '';
  if (normSub && normPred && normObj) {
    raw = `${normSub}:${normPred}:${normObj}`;
  } else {
    raw = normalizeFactString(input.factText);
  }

  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

/**
 * Local query term expansion for memory questions.
 * Extracts meaningful terms without calling an external AI.
 */
export function expandMemoryTerms(prompt: string): string[] {
  if (!prompt) return [];

  const stopWords = new Set([
    'apa', 'siapa', 'kapan', 'dimana', 'kenapa', 'mengapa', 'bagaimana',
    'yang', 'dan', 'di', 'ke', 'dari', 'ini', 'itu', 'ada', 'adalah',
    'apakah', 'siapakah', 'gak', 'ga', 'tidak', 'tahu', 'kah', 'sih',
    'dong', 'ya', 'kan', 'lah', 'tadi', 'barusan', 'sebelumnya', 'ingat',
    'masih', 'pernah', 'bilang', 'sebut', 'kita', 'saya', 'kamu', 'dia',
  ]);

  const clean = prompt
    .replace(/[^\w\s\u00C0-\u017F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean.split(' ').map((w) => w.trim()).filter((w) => w.length >= 2);
  const terms: string[] = [];

  for (const w of words) {
    const lower = w.toLowerCase();
    if (!stopWords.has(lower)) {
      terms.push(lower);
      // Indonesian suffix stripping: -nya, -ku, -mu, -kah, -lah
      if (lower.endsWith('nya') && lower.length > 4) {
        const root = lower.slice(0, -3);
        if (!stopWords.has(root)) terms.push(root);
      } else if ((lower.endsWith('ku') || lower.endsWith('mu')) && lower.length > 4) {
        const root = lower.slice(0, -2);
        if (!stopWords.has(root)) terms.push(root);
      }
    }
  }

  // Also preserve 2-word named phrases if present (e.g. "cia fei")
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i].toLowerCase();
    const w2 = words[i + 1].toLowerCase();
    if (!stopWords.has(w1) && !stopWords.has(w2)) {
      terms.push(`${w1} ${w2}`);
    }
  }

  return Array.from(new Set(terms));
}

/**
 * Save or update a learned fact.
 * - If same fingerprint exists: updates `last_seen_at` (deduplication).
 * - If subject and predicate match an existing active fact with different object:
 *   marks old fact as `superseded` and creates new active fact (contradiction resolution).
 */
export async function saveLearnedFact(input: CreateFactInput): Promise<{
  inserted: boolean;
  updated: boolean;
  fact: MemoryFact;
}> {
  const normText = normalizeFactString(input.factText);
  if (!normText) {
    throw new Error('Fact text cannot be empty');
  }

  const fingerprint = generateFactFingerprint(input);
  const confidence = input.confidence !== undefined ? input.confidence : 1.0;
  const now = new Date();

  // Try PostgreSQL if available
  if (getDbPool()) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // 1. Check if exact fingerprint already exists
      const existingRes = await client.query(
        `SELECT * FROM memory_facts WHERE fingerprint = $1 LIMIT 1;`,
        [fingerprint]
      );

      if (existingRes.rows.length > 0) {
        const row = existingRes.rows[0];
        await client.query(
          `UPDATE memory_facts SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
          [row.id]
        );
        await client.query('COMMIT');

        const updatedFact: MemoryFact = {
          id: row.id,
          factKey: row.fact_key,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          factText: row.fact_text,
          normalizedFact: row.normalized_fact,
          sourceMessageId: row.source_message_id,
          sourceChatId: row.source_chat_id,
          sourceSenderId: row.source_sender_id,
          sourceRole: row.source_role,
          confidence: row.confidence,
          status: row.status,
          fingerprint: row.fingerprint,
          firstSeenAt: new Date(row.first_seen_at),
          lastSeenAt: now,
          createdAt: new Date(row.created_at),
          updatedAt: now,
        };
        return { inserted: false, updated: true, fact: updatedFact };
      }

      // 2. Contradiction handling: check if active fact exists with same subject & predicate
      if (input.subject && input.predicate) {
        const normSub = normalizeFactString(input.subject);
        const normPred = normalizeFactString(input.predicate);

        await client.query(
          `UPDATE memory_facts
           SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
           WHERE LOWER(TRIM(subject)) = $1
             AND LOWER(TRIM(predicate)) = $2
             AND status = 'active';`,
          [normSub, normPred]
        );
      }

      // 3. Insert new active fact
      const insertSql = `
        INSERT INTO memory_facts (
          subject, predicate, object, fact_text, normalized_fact,
          source_message_id, source_chat_id, source_sender_id, source_role,
          confidence, status, fingerprint, first_seen_at, last_seen_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *;
      `;
      const insertRes = await client.query(insertSql, [
        input.subject?.trim() || null,
        input.predicate?.trim() || null,
        input.object?.trim() || null,
        input.factText.trim(),
        normText,
        input.sourceMessageId || null,
        input.sourceChatId || null,
        input.sourceSenderId || null,
        input.sourceRole || 'user',
        confidence,
        fingerprint,
      ]);

      await client.query('COMMIT');
      const row = insertRes.rows[0];
      const fact: MemoryFact = {
        id: row.id,
        factKey: row.fact_key,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        factText: row.fact_text,
        normalizedFact: row.normalized_fact,
        sourceMessageId: row.source_message_id,
        sourceChatId: row.source_chat_id,
        sourceSenderId: row.source_sender_id,
        sourceRole: row.source_role,
        confidence: row.confidence,
        status: row.status,
        fingerprint: row.fingerprint,
        firstSeenAt: new Date(row.first_seen_at),
        lastSeenAt: new Date(row.last_seen_at),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };

      return { inserted: true, updated: false, fact };
    } catch (err) {
      await client.query('ROLLBACK');
      logger.database.warn('Failed to save fact in PostgreSQL, falling back to in-memory:', (err as Error).message);
    } finally {
      client.release();
    }
  }

  // Fallback: in-memory store
  const existingIndex = inMemoryFacts.findIndex((f) => f.fingerprint === fingerprint);
  if (existingIndex >= 0) {
    inMemoryFacts[existingIndex].lastSeenAt = now;
    inMemoryFacts[existingIndex].updatedAt = now;
    return { inserted: false, updated: true, fact: inMemoryFacts[existingIndex] };
  }

  // Contradiction in-memory
  if (input.subject && input.predicate) {
    const normSub = normalizeFactString(input.subject);
    const normPred = normalizeFactString(input.predicate);
    for (const f of inMemoryFacts) {
      if (
        f.status === 'active' &&
        normalizeFactString(f.subject || '') === normSub &&
        normalizeFactString(f.predicate || '') === normPred
      ) {
        f.status = 'superseded';
        f.updatedAt = now;
      }
    }
  }

  const newFact: MemoryFact = {
    id: inMemoryFactId++,
    subject: input.subject?.trim() || null,
    predicate: input.predicate?.trim() || null,
    object: input.object?.trim() || null,
    factText: input.factText.trim(),
    normalizedFact: normText,
    sourceMessageId: input.sourceMessageId || null,
    sourceChatId: input.sourceChatId || null,
    sourceSenderId: input.sourceSenderId || null,
    sourceRole: input.sourceRole || 'user',
    confidence,
    status: 'active',
    fingerprint,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
  inMemoryFacts.push(newFact);
  return { inserted: true, updated: false, fact: newFact };
}

/**
 * Alias for saveLearnedFact
 */
export const upsertFact = saveLearnedFact;

/**
 * Search active facts using PostgreSQL FTS + ILIKE exact/phrase matching.
 */
export async function searchActiveFacts(
  queryPrompt: string,
  limit: number = config.memoryFactRetrievalLimit || 20
): Promise<MemoryFact[]> {
  if (!queryPrompt || !queryPrompt.trim()) return [];

  const cleanPrompt = queryPrompt.trim();
  const searchTerms = expandMemoryTerms(cleanPrompt);

  if (getDbPool()) {
    try {
      // 1. Try FTS match + ILIKE match
      const likeClause = searchTerms.length > 0
        ? searchTerms.map((_, idx) => `fact_text ILIKE $${idx + 2} OR subject ILIKE $${idx + 2} OR object ILIKE $${idx + 2}`).join(' OR ')
        : '1=1';

      const sql = `
        SELECT *
        FROM memory_facts
        WHERE status = 'active'
          AND (
            to_tsvector('simple', fact_text) @@ plainto_tsquery('simple', $1)
            OR (${likeClause})
          )
        ORDER BY last_seen_at DESC
        LIMIT ${limit};
      `;

      const params = [cleanPrompt, ...searchTerms.map((t) => `%${t}%`)];
      const res = await query(sql, params);

      if (res.rows.length > 0) {
        return res.rows.map((row) => ({
          id: row.id,
          factKey: row.fact_key,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          factText: row.fact_text,
          normalizedFact: row.normalized_fact,
          sourceMessageId: row.source_message_id,
          sourceChatId: row.source_chat_id,
          sourceSenderId: row.source_sender_id,
          sourceRole: row.source_role,
          confidence: row.confidence,
          status: row.status,
          fingerprint: row.fingerprint,
          firstSeenAt: new Date(row.first_seen_at),
          lastSeenAt: new Date(row.last_seen_at),
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        }));
      }
    } catch (err) {
      logger.database.warn('Facts search in PostgreSQL failed, falling back to in-memory:', (err as Error).message);
    }
  }

  // Fallback: search in-memory facts
  const termsLower = searchTerms.map((t) => t.toLowerCase());
  const promptLower = cleanPrompt.toLowerCase();

  const matched = inMemoryFacts
    .filter((f) => {
      if (f.status !== 'active') return false;
      const text = f.factText.toLowerCase();
      const sub = (f.subject || '').toLowerCase();
      const obj = (f.object || '').toLowerCase();
      if (text.includes(promptLower)) return true;
      return termsLower.some((t) => text.includes(t) || sub.includes(t) || obj.includes(t));
    })
    .slice(0, limit);

  return matched;
}

/**
 * Get all currently active facts for snapshot generation.
 */
export async function getAllActiveFacts(): Promise<MemoryFact[]> {
  if (getDbPool()) {
    try {
      const res = await query(`SELECT * FROM memory_facts WHERE status = 'active' ORDER BY last_seen_at DESC;`);
      return res.rows.map((row) => ({
        id: row.id,
        factKey: row.fact_key,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        factText: row.fact_text,
        normalizedFact: row.normalized_fact,
        sourceMessageId: row.source_message_id,
        sourceChatId: row.source_chat_id,
        sourceSenderId: row.source_sender_id,
        sourceRole: row.source_role,
        confidence: row.confidence,
        status: row.status,
        fingerprint: row.fingerprint,
        firstSeenAt: new Date(row.first_seen_at),
        lastSeenAt: new Date(row.last_seen_at),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));
    } catch (err) {
      logger.database.warn('Failed to fetch active facts from DB:', (err as Error).message);
    }
  }

  return inMemoryFacts.filter((f) => f.status === 'active');
}

let cachedActiveFactCount = 0;

/**
 * Refresh active facts count from DB or in-memory store.
 */
export async function refreshActiveFactCount(): Promise<number> {
  if (getDbPool()) {
    try {
      const res = await query(`SELECT COUNT(*) as count FROM memory_facts WHERE status = 'active';`);
      cachedActiveFactCount = parseInt(res.rows[0].count, 10) || 0;
      return cachedActiveFactCount;
    } catch {
      return cachedActiveFactCount;
    }
  }
  cachedActiveFactCount = inMemoryFacts.filter((f) => f.status === 'active').length;
  return cachedActiveFactCount;
}

/**
 * Count active facts synchronously (uses cached count when connected or in-memory array).
 */
export function getActiveFactCount(): number {
  if (!getDbPool()) {
    return inMemoryFacts.filter((f) => f.status === 'active').length;
  }
  return cachedActiveFactCount;
}

/**
 * Reset in-memory facts store (for unit tests).
 */
export function clearInMemoryFacts(): void {
  inMemoryFacts.length = 0;
  inMemoryFactId = 1;
  cachedActiveFactCount = 0;
}
