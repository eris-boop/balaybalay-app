/**
 * Database Schema & Idempotent Migrations.
 *
 * Ensures all required tables and indexes exist without dropping existing data.
 * All migrations are additive (ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS).
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

export const SCHEMA_SQL = `
-- 1. Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  chat_id VARCHAR(255) UNIQUE NOT NULL,
  chat_type VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(chat_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at);

-- 2. Messages table
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id VARCHAR(255) UNIQUE,
  sender_id VARCHAR(255),
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  model_used VARCHAR(100),
  task_type VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);

-- 3. Conversation Memories (Long-term summary) table
CREATE TABLE IF NOT EXISTS conversation_memories (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER UNIQUE NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversation_memories_conversation_id ON conversation_memories(conversation_id);
`;

/**
 * Additive migration SQL for global memory support.
 * Uses DO $$ blocks to check column existence before adding.
 */
export const GLOBAL_MEMORY_MIGRATION_SQL = `
-- Add memory_eligible column to messages (default true)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'memory_eligible'
  ) THEN
    ALTER TABLE messages ADD COLUMN memory_eligible BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;

-- Add source_type column to messages
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE messages ADD COLUMN source_type VARCHAR(50) NOT NULL DEFAULT 'private';
  END IF;
END $$;

-- Add chat_id column directly to messages for global queries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'chat_id'
  ) THEN
    ALTER TABLE messages ADD COLUMN chat_id VARCHAR(255);
  END IF;
END $$;

-- Add normalized_content column to messages
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'normalized_content'
  ) THEN
    ALTER TABLE messages ADD COLUMN normalized_content TEXT;
  END IF;
END $$;

-- Add reply_to_message_id column to messages
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'reply_to_message_id'
  ) THEN
    ALTER TABLE messages ADD COLUMN reply_to_message_id VARCHAR(255);
  END IF;
END $$;

-- Add learn_status column to messages
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'learn_status'
  ) THEN
    ALTER TABLE messages ADD COLUMN learn_status VARCHAR(50) NOT NULL DEFAULT 'pending';
  END IF;
END $$;

-- Add updated_at column to messages
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE messages ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

-- Indexes for global memory retrieval
CREATE INDEX IF NOT EXISTS idx_messages_memory_eligible ON messages(memory_eligible);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
CREATE INDEX IF NOT EXISTS idx_messages_learn_status ON messages(learn_status);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id);

-- GIN index for full-text search across all messages
CREATE INDEX IF NOT EXISTS idx_messages_content_fts ON messages USING gin(to_tsvector('simple', content));

-- 4. Global Memory table (shared long-term summary)
CREATE TABLE IF NOT EXISTS global_memory (
  id SERIAL PRIMARY KEY,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Bot Sent Messages table (tracks messages sent by bot for reply-to-bot quote detection)
CREATE TABLE IF NOT EXISTS bot_sent_messages (
  id SERIAL PRIMARY KEY,
  whatsapp_message_id VARCHAR(255) UNIQUE NOT NULL,
  chat_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bot_sent_messages_wa_id ON bot_sent_messages(whatsapp_message_id);
CREATE INDEX IF NOT EXISTS idx_bot_sent_messages_chat_id ON bot_sent_messages(chat_id);

-- 6. Memory Ingestion Queue table (asynchronous background knowledge learner)
CREATE TABLE IF NOT EXISTS memory_ingest_queue (
  id SERIAL PRIMARY KEY,
  message_id VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  processing_started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_memory_ingest_queue_status ON memory_ingest_queue(status);
CREATE INDEX IF NOT EXISTS idx_memory_ingest_queue_retry ON memory_ingest_queue(next_retry_at);

-- 7. Memory Facts table (extracted durable knowledge with fingerprinting & status)
CREATE TABLE IF NOT EXISTS memory_facts (
  id SERIAL PRIMARY KEY,
  fact_key VARCHAR(255),
  subject TEXT,
  predicate TEXT,
  object TEXT,
  fact_text TEXT NOT NULL,
  normalized_fact TEXT NOT NULL,
  source_message_id VARCHAR(255),
  source_chat_id VARCHAR(255),
  source_sender_id VARCHAR(255),
  source_role VARCHAR(50) DEFAULT 'user',
  confidence REAL DEFAULT 1.0,
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, superseded, disputed
  fingerprint VARCHAR(255) UNIQUE,
  first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_status ON memory_facts(status);
CREATE INDEX IF NOT EXISTS idx_memory_facts_fingerprint ON memory_facts(fingerprint);
CREATE INDEX IF NOT EXISTS idx_memory_facts_subject ON memory_facts(subject);
CREATE INDEX IF NOT EXISTS idx_memory_facts_fts ON memory_facts USING gin(to_tsvector('simple', fact_text));
`;

/**
 * Initialize schema idempotently.
 */
export async function ensureSchema(runner: Pool | PoolClient): Promise<void> {
  try {
    await runner.query(SCHEMA_SQL);
    logger.database.info('Database schema verified/migrated successfully');

    // Run global memory & knowledge migration (additive, safe to re-run)
    await runner.query(GLOBAL_MEMORY_MIGRATION_SQL);
    logger.database.info('Global memory and knowledge schema migration applied successfully');
  } catch (err) {
    logger.database.error('Failed to ensure database schema:', (err as Error).message);
    throw err;
  }
}
