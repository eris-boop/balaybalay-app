/**
 * Express server entry point.
 * Sets up middleware, routes, and starts listening.
 */

import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { webhookRouter } from './routes/webhook';
import { adminRouter } from './routes/admin';
import {
  initWhatsAppClient,
  disconnectWhatsApp,
  getWhatsAppStatus,
} from './services/whatsappClient';
import { logger } from './utils/logger';
import { initDatabase, closeDatabase, getDbPool } from './database/db';
import { ensureSchema } from './database/schema';

const app = express();

// --- Security middleware ---
app.use(helmet());

// --- Body parsing with size limit ---
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// --- Request logging (non-sensitive) ---
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    logger.server.info(`${req.method} ${req.path}`);
  }
  next();
});

// --- Health check endpoint ---
app.get('/health', (_req, res) => {
  const wsStatus = getWhatsAppStatus();
  res.status(200).json({
    status: 'ok',
    whatsappProvider: wsStatus.provider,
    whatsappConnected: wsStatus.connected,
    pairingRequired: wsStatus.pairingRequired,
    messageHandlerReady: wsStatus.messageHandlerReady,
    lastMessageAt: wsStatus.lastMessageAt ? new Date(wsStatus.lastMessageAt).toISOString() : null,
    lastReplyAt: wsStatus.lastReplyAt ? new Date(wsStatus.lastReplyAt).toISOString() : null,
  });
});

// --- Root endpoint ---
app.get('/', (_req, res) => {
  res.status(200).json({
    name: 'BalayBalay WhatsApp AI Bot',
    status: 'running',
  });
});

// --- Admin routes (QR login) ---
app.use('/admin', adminRouter);

// --- Webhook routes (legacy/fallback if needed) ---
app.use('/webhook', webhookRouter);

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Global error handler ---
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error.error('Unhandled express error:', err.message);
  res.status(500).json({
    error: config.isProduction ? 'Internal server error' : err.message,
  });
});

// --- Start server ---
const server = app.listen(config.port, '0.0.0.0', () => {
  logger.server.info(`BalayBalay WhatsApp AI Bot started`);
  logger.server.info(`Listening on 0.0.0.0:${config.port}`);
  logger.server.info(`Environment: ${config.nodeEnv}`);
  logger.server.info(`WhatsApp Provider: ${config.whatsappProvider}`);
  logger.server.info(`AI Provider: ${config.aiProvider}`);
  logger.server.info(`Primary AI Model: ${config.aiProvider === 'vpsmurah' ? (config.aiModelChain[0] || 'none') : config.geminiModel}`);
  logger.server.info(`Private chat responses: ${config.respondInPrivate ? 'enabled' : 'disabled'}`);

  // Initialize PostgreSQL database and ensure schema
  if (config.databaseUrl) {
    initDatabase()
      .then(async (connected: boolean) => {
        if (connected) {
          const pool = getDbPool();
          if (pool) {
            await ensureSchema(pool);
          }
        }
      })
      .catch((err: unknown) => {
        logger.database.warn('[DATABASE] unavailable - startup init failed:', (err as Error).message);
      });
  }

  // Initialize Baileys client if configured
  if (config.whatsappProvider === 'baileys') {
    initWhatsAppClient().catch((err) => {
      logger.error.error('Failed to initialize Baileys WhatsApp client:', (err as Error).message);
    });
  }
});

// --- Graceful shutdown ---
function shutdown(signal: string) {
  logger.server.info(`${signal} received, shutting down gracefully...`);
  disconnectWhatsApp();
  closeDatabase().catch((err: unknown) => {
    logger.database.error('Error closing database on shutdown:', (err as Error).message);
  });
  server.close(() => {
    logger.server.info('Server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.server.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error.error('Uncaught exception:', err.message);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error.error('Unhandled rejection:', String(reason));
});

export { app };
