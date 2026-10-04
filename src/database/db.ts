/**
 * PostgreSQL Database Connection Pool & Lifecycle Management.
 *
 * Connects to PostgreSQL via internal Coolify/Docker network using DATABASE_URL.
 * Gracefully handles connection failures without crashing the WhatsApp bot.
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

let pool: Pool | null = null;
let isConnected = false;

/**
 * Initialize or get the singleton connection pool.
 */
export function getDbPool(): Pool | null {
  if (pool) return pool;

  if (!config.databaseUrl) {
    logger.database.info('DATABASE_URL not configured. Running with in-memory memory store.');
    return null;
  }

  try {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.database.error('[DATABASE] unavailable - pool background error:', err.message);
      isConnected = false;
    });

    return pool;
  } catch (err) {
    logger.database.error('[DATABASE] unavailable - failed to create pool:', (err as Error).message);
    return null;
  }
}

/**
 * Allow test suites to inject a mock pool or SQLite/PG adapter.
 */
export function setTestDbPool(customPool: Pool | null): void {
  pool = customPool;
  isConnected = customPool !== null;
}

/**
 * Check if PostgreSQL is currently reachable.
 */
export function isDatabaseConnected(): boolean {
  return isConnected;
}

/**
 * Execute a parameterized query with connection check & error handling.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const activePool = getDbPool();
  if (!activePool) {
    throw new Error('Database pool not initialized or unavailable');
  }

  try {
    const res = await activePool.query<T>(text, params);
    isConnected = true;
    return res;
  } catch (err) {
    logger.database.warn('[DATABASE] unavailable - query error:', (err as Error).message);
    isConnected = false;
    throw err;
  }
}

/**
 * Get a client from pool for transactions.
 */
export async function getClient(): Promise<PoolClient> {
  const activePool = getDbPool();
  if (!activePool) {
    throw new Error('Database pool not initialized or unavailable');
  }

  try {
    const client = await activePool.connect();
    isConnected = true;
    return client;
  } catch (err) {
    logger.database.warn('[DATABASE] unavailable - connection error:', (err as Error).message);
    isConnected = false;
    throw err;
  }
}

/**
 * Test connection and initialize database schema on startup.
 */
export async function initDatabase(): Promise<boolean> {
  if (!config.databaseUrl) {
    logger.database.info('No DATABASE_URL configured, persistent memory will use in-memory fallback');
    return false;
  }

  try {
    const activePool = getDbPool();
    if (!activePool) return false;

    // Test connectivity
    const client = await activePool.connect();
    try {
      await client.query('SELECT 1');
      isConnected = true;
      logger.database.info('Database connection established successfully');
    } finally {
      client.release();
    }

    return true;
  } catch (err) {
    isConnected = false;
    logger.database.warn('[DATABASE] unavailable - startup check failed:', (err as Error).message);
    return false;
  }
}

/**
 * Close database pool cleanly on process shutdown.
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      logger.database.info('Database pool closed');
    } catch (err) {
      logger.database.error('Error closing database pool:', (err as Error).message);
    } finally {
      pool = null;
      isConnected = false;
    }
  }
}
