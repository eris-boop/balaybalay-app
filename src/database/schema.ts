/**
 * Database Schema & Idempotent Migrations.
 *
 * Ensures all required tables and indexes exist without dropping existing data.
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
 * Initialize schema idempotently.
 */
export async function ensureSchema(runner: Pool | PoolClient): Promise<void> {
  try {
    await runner.query(SCHEMA_SQL);
    logger.database.info('Database schema verified/migrated successfully');
  } catch (err) {
    logger.database.error('Failed to ensure database schema:', (err as Error).message);
    throw err;
  }
}
