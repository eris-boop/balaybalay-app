/**
 * Conversation memory service.
 * Stores chat history per chatId for context-aware AI responses.
 *
 * Current implementation: in-memory Map.
 * Designed to be easily swapped to Redis/PostgreSQL later.
 */

import { ConversationEntry } from '../types/whatsapp';
import { config } from '../config';

export interface MemoryStore {
  getHistory(chatId: string): ConversationEntry[];
  addEntry(chatId: string, entry: ConversationEntry): void;
  clearHistory(chatId: string): void;
  clearAll(): void;
}

class InMemoryStore implements MemoryStore {
  private store = new Map<string, ConversationEntry[]>();

  getHistory(chatId: string): ConversationEntry[] {
    return this.store.get(chatId) || [];
  }

  addEntry(chatId: string, entry: ConversationEntry): void {
    const history = this.store.get(chatId) || [];
    history.push(entry);

    // Trim to max history, keeping pairs (user + assistant)
    const maxEntries = config.maxHistoryMessages * 2;
    if (history.length > maxEntries) {
      history.splice(0, history.length - maxEntries);
    }

    this.store.set(chatId, history);
  }

  clearHistory(chatId: string): void {
    this.store.delete(chatId);
  }

  clearAll(): void {
    this.store.clear();
  }
}

// Singleton instance - swap this to create a Redis/PG-backed store
export const memory: MemoryStore = new InMemoryStore();
