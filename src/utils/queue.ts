/**
 * Per-chat concurrency queue (mutex) with hard deadline.
 * Ensures that for a given chatId, messages are processed sequentially in FIFO order.
 * Prevents race conditions on conversation history when multiple messages arrive close together.
 * Different chatIds run concurrently without blocking each other.
 * Enforces CHAT_JOB_TIMEOUT_MS to prevent one hung message from blocking the chat forever.
 */

import { config } from '../config';
import { logger } from './logger';

class ChatQueue {
  private queues = new Map<string, Promise<unknown>>();

  /**
   * Run a task within the per-chat queue.
   * Guarantees queue lock is released in finally even on timeout, exception, or AbortError.
   */
  async run<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const current = this.queues.get(chatId) || Promise.resolve();

    let taskPromise: Promise<T>;

    const executeWithTimeout = async (): Promise<T> => {
      logger.queue.info('job started');

      // Wait for any previous pending job on this chat to settle
      try {
        await current;
      } catch {
        // Prior job failure or timeout does not block subsequent jobs
      }

      const timeoutMs = config.chatJobTimeoutMs || 30000;
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err: any = new Error(`Chat job timed out after ${timeoutMs}ms`);
          err.isJobTimeout = true;
          reject(err);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });

      try {
        const result = await Promise.race([task(), timeoutPromise]);
        logger.queue.info('job completed');
        return result;
      } catch (err) {
        logger.queue.warn('job failed - released');
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    taskPromise = executeWithTimeout();
    this.queues.set(chatId, taskPromise);

    try {
      return await taskPromise;
    } finally {
      if (this.queues.get(chatId) === taskPromise) {
        this.queues.delete(chatId);
      }
    }
  }

  /**
   * Check if a given chatId has work currently queued or running.
   */
  isBusy(chatId: string): boolean {
    return this.queues.has(chatId);
  }

  /**
   * Clear all active queues (useful in test teardown).
   */
  clear(): void {
    this.queues.clear();
  }
}

export const chatQueue = new ChatQueue();
