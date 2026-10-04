/**
 * Idempotency service.
 * Prevents duplicate processing of the same webhook event or message.
 * Uses in-memory cache with TTL-based expiry.
 */

import { logger } from '../utils/logger';

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Clean up every 1 minute

class IdempotencyCache {
  private cache = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Check if a message ID has been seen before.
   * If not, marks it as seen and returns false.
   * If already seen, returns true.
   */
  isDuplicate(id: string): boolean {
    if (!id) return false;

    const now = Date.now();

    if (this.cache.has(id)) {
      const seenAt = this.cache.get(id)!;
      if (now - seenAt < TTL_MS) {
        logger.webhook.debug(`Duplicate detected: ${id}`);
        return true;
      }
      // Expired entry, treat as new
    }

    this.cache.set(id, now);
    return false;
  }

  /**
   * Remove expired entries.
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, seenAt] of this.cache.entries()) {
      if (now - seenAt >= TTL_MS) {
        this.cache.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.webhook.debug(`Idempotency cache cleanup: removed ${cleaned} entries, ${this.cache.size} remaining`);
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if cleanup is scheduled
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }
}

export const idempotency = new IdempotencyCache();
