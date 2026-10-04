/**
 * Per-chat concurrency queue (mutex).
 * Ensures that for a given chatId, messages are processed sequentially in FIFO order.
 * Prevents race conditions on conversation history when multiple messages arrive close together.
 * Different chatIds run concurrently without blocking each other.
 */

class ChatQueue {
  private queues = new Map<string, Promise<unknown>>();

  /**
   * Run a task within the per-chat queue.
   */
  async run<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const current = this.queues.get(chatId) || Promise.resolve();

    let result!: T;
    let taskError: unknown = null;

    const next = current.then(async () => {
      try {
        result = await task();
      } catch (err) {
        taskError = err;
      }
    });

    this.queues.set(chatId, next);

    next.finally(() => {
      if (this.queues.get(chatId) === next) {
        this.queues.delete(chatId);
      }
    });

    await next;

    if (taskError) {
      throw taskError;
    }

    return result;
  }

  /**
   * Check if a given chatId has work currently queued or running.
   */
  isBusy(chatId: string): boolean {
    return this.queues.has(chatId);
  }
}

export const chatQueue = new ChatQueue();
