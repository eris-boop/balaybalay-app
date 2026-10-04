/**
 * Rate limiting service.
 * Limits requests per sender/chat within a sliding window.
 * In-memory implementation with automatic cleanup.
 */

import { config } from '../config';
import { logger } from '../utils/logger';

const WINDOW_MS = 60 * 1000; // 1 minute window
const CLEANUP_INTERVAL_MS = 30 * 1000;

interface RateEntry {
  timestamps: number[];
  warned: boolean;
}

class RateLimiter {
  private store = new Map<string, RateEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Check if a sender has exceeded the rate limit.
   * Returns true if rate limited.
   */
  isRateLimited(senderId: string): boolean {
    const now = Date.now();
    const limit = config.rateLimitPerMinute;

    let entry = this.store.get(senderId);
    if (!entry) {
      entry = { timestamps: [], warned: false };
      this.store.set(senderId, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);

    if (entry.timestamps.length >= limit) {
      if (!entry.warned) {
        logger.rateLimit.warn(`Rate limit exceeded for ${senderId.substring(0, 8)}...`);
        entry.warned = true;
      }
      return true;
    }

    entry.timestamps.push(now);
    entry.warned = false;
    return false;
  }

  /**
   * Check if this is the first rate limit hit (for sending a one-time warning).
   */
  isFirstWarning(senderId: string): boolean {
    const entry = this.store.get(senderId);
    if (!entry) return false;
    return entry.warned;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);
      if (entry.timestamps.length === 0) {
        this.store.delete(key);
      }
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }
}

export const rateLimiter = new RateLimiter();
