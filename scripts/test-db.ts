/**
 * Live PostgreSQL Database Verification Script.
 *
 * Tests:
 * 1. Connection to DATABASE_URL via pool
 * 2. SELECT 1 ping
 * 3. Schema verification / migration
 * 4. Temporary test conversation & message insertion and retrieval
 * 5. Cleanup of temporary test record
 *
 * Usage:
 * npm run test:db
 */

import dotenv from 'dotenv';
import path from 'path';

// Always load .env
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

import { Pool } from 'pg';
import { ensureSchema } from '../src/database/schema';

async function run() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('[DB TEST] ERROR: DATABASE_URL is not set in environment or .env file');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });

  const testChatId = `test_db_ping_${Date.now()}@s.whatsapp.net`;

  try {
    // 1. Connection test
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      console.log('[DB TEST] connection OK');

      // 2. Schema check
      await ensureSchema(client);
      console.log('[DB TEST] schema OK');

      // 3. Read/Write test with temporary conversation
      const insertConvRes = await client.query(
        `INSERT INTO conversations (chat_id, chat_type) VALUES ($1, 'private') RETURNING id;`,
        [testChatId]
      );
      const convId = insertConvRes.rows[0].id;

      await client.query(
        `INSERT INTO messages (conversation_id, role, content, message_id) VALUES ($1, 'user', 'Ping test', $2);`,
        [convId, `msg_${Date.now()}`]
      );

      const readRes = await client.query(
        `SELECT content FROM messages WHERE conversation_id = $1 LIMIT 1;`,
        [convId]
      );

      if (readRes.rows.length > 0 && readRes.rows[0].content === 'Ping test') {
        console.log('[DB TEST] read/write OK');
      } else {
        throw new Error('Read verification failed: message content does not match');
      }

      // 4. Cleanup temporary test record
      await client.query(`DELETE FROM conversations WHERE id = $1;`, [convId]);
      console.log('[DB TEST] cleanup OK');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[DB TEST] FAILED:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
