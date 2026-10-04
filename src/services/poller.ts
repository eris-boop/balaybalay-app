/**
 * DEPRECATED: VPSMurah Inbox Poller Service.
 *
 * This service is permanently DISABLED.
 * WhatsApp incoming and outgoing messages are now handled directly via
 * the Baileys WebSocket connection (@whiskeysockets/baileys).
 *
 * VPSMurah polling resulted in HTTP 501 and exhausted account credits.
 * No setInterval or HTTP polling requests are performed.
 */

import { logger } from '../utils/logger';

/**
 * Execute a single poll cycle (DISABLED).
 */
export async function pollOnce(): Promise<void> {
  logger.polling.warn('VPSMurah polling is disabled. WhatsApp connection is handled via Baileys WebSocket.');
}

/**
 * Start the poller (DISABLED).
 * Always returns false and does NOT start any timers.
 */
export function startPoller(_overrideIntervalMs?: number): boolean {
  logger.polling.warn('VPSMurah inbox poller is disabled and will not start. Using Baileys WebSocket.');
  return false;
}

/**
 * Stop the poller (DISABLED).
 */
export function stopPoller(): void {
  // No-op since poller is permanently disabled
}

/**
 * Check whether the poller is currently active.
 */
export function isPollerRunning(): boolean {
  return false;
}

/**
 * Check whether a poll HTTP call is currently in flight.
 */
export function isPollActive(): boolean {
  return false;
}

/**
 * Get current poller status.
 */
export function getPollerStatus(): { running: boolean; intervalMs: number } {
  return {
    running: false,
    intervalMs: 0,
  };
}
