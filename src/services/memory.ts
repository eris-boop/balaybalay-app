/**
 * Unified Conversation Memory Service.
 *
 * Provides:
 * 1. Synchronous in-memory store for fallback, unit tests, and fast access.
 * 2. Asynchronous PostgreSQL persistent memory with full-text search and long-term summaries.
 * 3. Graceful degradation: if PostgreSQL is unavailable, automatically falls back to in-memory.
 */

import { ConversationEntry } from '../types/whatsapp';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isDatabaseConnected } from '../database/db';
import {
  loadConversationContext,
  saveSuccessfulTurn,
  SaveTurnParams,
  LoadedContext,
} from '../database/memoryRepository';
import { deleteConversation as dbDeleteConversation, deleteAllConversations as dbDeleteAll } from '../database/conversations';

export interface MemoryStore {
  getHistory(chatId: string): ConversationEntry[];
  addEntry(chatId: string, entry: ConversationEntry): void;
  clearHistory(chatId: string): void;
  clearAll(): void;
  loadContext(chatId: string, currentPrompt: string): Promise<LoadedContext>;
  saveTurn(params: SaveTurnParams): Promise<void>;
  deleteConversation(chatId: string): Promise<boolean>;
}

class HybridMemoryStore implements MemoryStore {
  private inMemoryStore = new Map<string, ConversationEntry[]>();

  /**
   * Get in-memory history synchronously (backward-compatible).
   */
  getHistory(chatId: string): ConversationEntry[] {
    return this.inMemoryStore.get(chatId) || [];
  }

  /**
   * Add a single entry into in-memory store.
   */
  addEntry(chatId: string, entry: ConversationEntry): void {
    const history = this.inMemoryStore.get(chatId) || [];
    history.push(entry);

    const maxEntries = config.maxHistoryMessages * 2;
    if (history.length > maxEntries) {
      history.splice(0, history.length - maxEntries);
    }

    this.inMemoryStore.set(chatId, history);
  }

  /**
   * Clear in-memory history for a specific chat.
   */
  clearHistory(chatId: string): void {
    this.inMemoryStore.delete(chatId);
  }

  /**
   * Clear all in-memory history.
   */
  clearAll(): void {
    this.inMemoryStore.clear();
    if (isDatabaseConnected()) {
      dbDeleteAll().catch((err) => {
        logger.database.warn('Failed to clear database conversations:', (err as Error).message);
      });
    }
  }

  /**
   * Load rich conversation context:
   * - Recent history
   * - Long-term memory summary
   * - Relevant old messages via full-text search
   * Falls back to in-memory store if database is offline.
   */
  async loadContext(chatId: string, currentPrompt: string): Promise<LoadedContext> {
    if (isDatabaseConnected()) {
      try {
        const dbContext = await loadConversationContext(chatId, currentPrompt);
        // Sync in-memory cache with db's recent history
        if (dbContext.recentHistory.length > 0) {
          this.inMemoryStore.set(chatId, [...dbContext.recentHistory]);
        }
        return dbContext;
      } catch (err) {
        logger.database.warn('[DATABASE] unavailable, falling back to in-memory context:', (err as Error).message);
      }
    }

    // In-memory fallback
    const memHistory = this.getHistory(chatId);
    return {
      recentHistory: memHistory,
      summary: null,
      relevantOldMessages: [],
    };
  }

  /**
   * Transactionally save successful conversation turn into both
   * persistent PostgreSQL storage and in-memory cache.
   */
  async saveTurn(params: SaveTurnParams): Promise<void> {
    const now = Date.now();

    // 1. Update in-memory cache
    this.addEntry(params.chatId, {
      role: 'user',
      content: params.userPrompt,
      timestamp: now,
    });

    this.addEntry(params.chatId, {
      role: 'assistant',
      content: params.assistantReply,
      timestamp: now,
    });

    // 2. Persist to PostgreSQL if connected
    if (isDatabaseConnected()) {
      try {
        await saveSuccessfulTurn(params);
      } catch (err) {
        logger.database.warn('[DATABASE] unavailable - turn saved to in-memory only:', (err as Error).message);
      }
    }
  }

  /**
   * Delete conversation from both database and in-memory cache.
   */
  async deleteConversation(chatId: string): Promise<boolean> {
    this.clearHistory(chatId);

    if (isDatabaseConnected()) {
      try {
        return await dbDeleteConversation(chatId);
      } catch (err) {
        logger.database.warn('Failed to delete conversation from database:', (err as Error).message);
        return false;
      }
    }

    return true;
  }
}

export const memory = new HybridMemoryStore();
