/**
 * Express server entry point.
 * Sets up middleware, routes, and starts listening.
 */

import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { webhookRouter } from './routes/webhook';
import { startPoller, stopPoller } from './services/poller';
import { logger } from './utils/logger';

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
  res.status(200).json({
    status: 'ok',
    polling: config.pollingEnabled,
    pollIntervalMs: config.pollIntervalMs,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// --- Root endpoint ---
app.get('/', (_req, res) => {
  res.status(200).json({
    name: 'BalayBalay WhatsApp AI Bot',
    status: 'running',
  });
});

// --- Webhook routes ---
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
  logger.server.info(`Model: ${config.geminiModel}`);
  logger.server.info(`Private chat responses: ${config.respondInPrivate ? 'enabled' : 'disabled'}`);
  logger.server.info(`Rate limit: ${config.rateLimitPerMinute}/min`);

  // Start background inbox poller
  if (config.pollingEnabled) {
    startPoller();
  }
});

// --- Graceful shutdown ---
function shutdown(signal: string) {
  logger.server.info(`${signal} received, shutting down gracefully...`);
  stopPoller();
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
