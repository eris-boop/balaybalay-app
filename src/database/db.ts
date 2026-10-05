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
let dbHealth: 'healthy' | 'degraded' | 'disconnected' = 'disconnected';

/**
 * Initialize or get the singleton connection pool.
 */
export function getDbPool(): Pool | null {
  if (pool) return pool;

  if (!config.databaseUrl) {
    logger.database.info('DATABASE_URL not configured. Running with in-memory memory store.');
    dbHealth = 'disconnected';
    return null;
  }

  try {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax || 10,
      idleTimeoutMillis: config.dbIdleTimeoutMs || 30000,
      connectionTimeoutMillis: config.dbConnectionTimeoutMs || 10000,
    });

    pool.on('error', (err) => {
      logger.database.error('[DATABASE] unavailable - pool background error:', err.message);
      isConnected = false;
      dbHealth = 'degraded';
    });

    return pool;
  } catch (err) {
    logger.database.error('[DATABASE] unavailable - failed to create pool:', (err as Error).message);
    dbHealth = 'disconnected';
    return null;
  }
}

/**
 * Allow test suites to inject a mock pool or SQLite/PG adapter.
 */
export function setTestDbPool(customPool: Pool | null): void {
  pool = customPool;
  isConnected = customPool !== null;
  dbHealth = customPool !== null ? 'healthy' : 'disconnected';
}

/**
 * Check if PostgreSQL is currently reachable.
 */
export function isDatabaseConnected(): boolean {
  return isConnected;
}

/**
 * Get current database health and pool metrics.
 */
export function getDatabaseHealth(): {
  status: 'healthy' | 'degraded' | 'disconnected';
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
} {
  const p = pool as any;
  return {
    status: dbHealth,
    poolTotal: p?.totalCount ?? 0,
    poolIdle: p?.idleCount ?? 0,
    poolWaiting: p?.waitingCount ?? 0,
  };
}

/**
 * Update internal database health status.
 */
export function setDatabaseHealthStatus(status: 'healthy' | 'degraded' | 'disconnected'): void {
  dbHealth = status;
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
    dbHealth = 'disconnected';
    throw new Error('Database pool not initialized or unavailable');
  }

  try {
    const res = await activePool.query<T>(text, params);
    isConnected = true;
    dbHealth = 'healthy';
    return res;
  } catch (err) {
    logger.database.warn('[DATABASE] unavailable - query error:', (err as Error).message);
    isConnected = false;
    dbHealth = 'degraded';
    throw err;
  }
}

/**
 * Get a client from pool for transactions.
 */
export async function getClient(): Promise<PoolClient> {
  const activePool = getDbPool();
  if (!activePool) {
    dbHealth = 'disconnected';
    throw new Error('Database pool not initialized or unavailable');
  }

  try {
    const client = await activePool.connect();
    isConnected = true;
    dbHealth = 'healthy';
    return client;
  } catch (err) {
    logger.database.warn('[DATABASE] unavailable - connection error:', (err as Error).message);
    isConnected = false;
    dbHealth = 'degraded';
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
