/**
 * Polling service for VPSMurah WhatsApp /wa-api/inbox.
 *
 * Fetches messages periodically from:
 * GET https://my.vpsmurah.co.id/api/svc/v1/wa-api/inbox
 *
 * Features:
 * - Minimum interval enforcement (5000ms minimum)
 * - Concurrency guard against overlapping poll runs
 * - 25-second AbortController timeout
 * - Resilient error handling (400, 401, 403, 429, 500+, timeouts) without crashing
 * - Redaction of API keys and secrets in logs
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { parseVpsmurahInbox } from '../providers/vpsmurahInbox';
import { processIncomingMessage } from './messageProcessor';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let isPollInProgress = false;
let activeIntervalMs = 60000;

/**
 * Execute a single poll cycle to fetch and process inbox messages.
 */
export async function pollOnce(): Promise<void> {
  // Concurrency guard: avoid overlapping runs if a previous request is still running
  if (isPollInProgress) {
    logger.polling.debug('Previous polling cycle still in progress, skipping overlapping run');
    return;
  }

  isPollInProgress = true;
  const controller = new AbortController();
  const timeoutMs = 25_000; // 25 seconds timeout
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(config.vpsmurahInboxUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.vpsmurahApiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      logger.polling.error(`Polling failed: status=${status}`);
      return;
    }

    const data = await response.json().catch(() => null);
    const messages = parseVpsmurahInbox(data);

    if (messages.length > 0) {
      logger.polling.info(`Polled ${messages.length} message(s) from inbox`);
      for (const msg of messages) {
        try {
          await processIncomingMessage(msg);
        } catch (itemErr) {
          logger.polling.error('Error processing inbox message:', (itemErr as Error).message);
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.polling.error('Polling failed: request timed out');
      return;
    }

    const rawError = (err as Error).message || 'Unknown network error';
    const sanitized = config.vpsmurahApiKey
      ? rawError.replaceAll(config.vpsmurahApiKey, '[REDACTED]')
      : rawError;

    logger.polling.error(`Polling failed: ${sanitized}`);
  } finally {
    clearTimeout(timeoutId);
    isPollInProgress = false;
  }
}

/**
 * Start the background poller if enabled.
 * Ensures only ONE active poller exists per process.
 */
export function startPoller(overrideIntervalMs?: number): boolean {
  if (!config.pollingEnabled) {
    logger.polling.info('Polling is disabled (POLLING_ENABLED=false)');
    return false;
  }

  if (isRunning) {
    logger.polling.warn('Poller is already running in this process');
    return false;
  }

  // Enforce minimum 5000ms polling interval to prevent excessive API credit drain
  const requestedInterval = overrideIntervalMs ?? config.pollIntervalMs;
  activeIntervalMs = Math.max(5000, requestedInterval);

  isRunning = true;
  logger.polling.info(`Started with interval ${activeIntervalMs}ms`);

  // Run initial poll cycle asynchronously
  pollOnce().catch((err) => {
    logger.polling.error('Unhandled error in initial poll:', (err as Error).message);
  });

  // Schedule recurring polling cycles
  pollTimer = setInterval(() => {
    pollOnce().catch((err) => {
      logger.polling.error('Unhandled error in recurring poll:', (err as Error).message);
    });
  }, activeIntervalMs);

  if (pollTimer.unref) {
    pollTimer.unref();
  }

  return true;
}

/**
 * Stop the background poller.
 */
export function stopPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
  isPollInProgress = false;
  logger.polling.info('Stopped poller');
}

/**
 * Check whether the poller is currently active.
 */
export function isPollerRunning(): boolean {
  return isRunning;
}

/**
 * Check whether a poll HTTP call is currently in flight.
 */
export function isPollActive(): boolean {
  return isPollInProgress;
}

/**
 * Get current poller status and interval.
 */
export function getPollerStatus(): { running: boolean; intervalMs: number } {
  return {
    running: isRunning,
    intervalMs: activeIntervalMs,
  };
}
