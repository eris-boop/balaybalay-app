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
import { isDatabaseConnected, getDbPool } from '../database/db';
import {
  loadConversationContext,
  saveSuccessfulTurn,
  SaveTurnParams,
  LoadedContext,
} from '../database/memoryRepository';
import { deleteConversation as dbDeleteConversation, deleteAllConversations as dbDeleteAll } from '../database/conversations';
import { isFallbackOrErrorText } from './aiService';

export interface MemoryStore {
  getHistory(chatId: string): ConversationEntry[];
  addEntry(chatId: string, entry: ConversationEntry): void;
  clearHistory(chatId: string): void;
  clearAll(): void;
  loadContext(chatId: string, currentPrompt: string): Promise<LoadedContext>;
  saveTurn(params: SaveTurnParams): Promise<void>;
  deleteConversation(chatId: string): Promise<boolean>;
}

export interface MemoryDiagnostics {
  lastMemoryLoadAt: string | null;
  lastMemorySaveAt: string | null;
  lastMemoryChatFound: boolean | null;
  lastMemoryRecentCount: number;
  lastMemoryRelevantCount: number;
  lastMemorySummaryUsed: boolean;
}

const memoryDiagnostics: MemoryDiagnostics = {
  lastMemoryLoadAt: null,
  lastMemorySaveAt: null,
  lastMemoryChatFound: null,
  lastMemoryRecentCount: 0,
  lastMemoryRelevantCount: 0,
  lastMemorySummaryUsed: false,
};

export function getMemoryDiagnostics(): MemoryDiagnostics {
  return { ...memoryDiagnostics };
}

export function resetMemoryDiagnostics(): void {
  memoryDiagnostics.lastMemoryLoadAt = null;
  memoryDiagnostics.lastMemorySaveAt = null;
  memoryDiagnostics.lastMemoryChatFound = null;
  memoryDiagnostics.lastMemoryRecentCount = 0;
  memoryDiagnostics.lastMemoryRelevantCount = 0;
  memoryDiagnostics.lastMemorySummaryUsed = false;
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
    if (getDbPool()) {
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
    const hasPool = Boolean(getDbPool());
    let dbContext: LoadedContext | null = null;
    let chatFound = false;

    if (hasPool) {
      try {
        dbContext = await loadConversationContext(chatId, currentPrompt);
        chatFound = dbContext.recentHistory.length > 0 || Boolean(dbContext.summary);
        // Sync in-memory cache with db's recent history
        if (dbContext.recentHistory.length > 0) {
          this.inMemoryStore.set(chatId, [...dbContext.recentHistory]);
        }
      } catch (err) {
        logger.database.warn('[DATABASE] unavailable, falling back to in-memory context:', (err as Error).message);
      }
    }

    const recentHistory = dbContext ? dbContext.recentHistory : this.getHistory(chatId);
    const summary = dbContext ? dbContext.summary : null;
    const relevantOldMessages = dbContext ? dbContext.relevantOldMessages : [];

    memoryDiagnostics.lastMemoryLoadAt = new Date().toISOString();
    memoryDiagnostics.lastMemoryChatFound = hasPool ? chatFound : (this.inMemoryStore.has(chatId) ? true : null);
    memoryDiagnostics.lastMemoryRecentCount = recentHistory.length;
    memoryDiagnostics.lastMemoryRelevantCount = relevantOldMessages.length;
    memoryDiagnostics.lastMemorySummaryUsed = Boolean(summary);

    logger.memory.info(
      `[memory] loaded recent=${recentHistory.length} relevant=${relevantOldMessages.length} summary=${Boolean(summary)}`
    );

    return {
      recentHistory,
      summary,
      relevantOldMessages,
    };
  }

  /**
   * Transactionally save successful conversation turn into both
   * persistent PostgreSQL storage and in-memory cache.
   */
  async saveTurn(params: SaveTurnParams): Promise<void> {
    if (isFallbackOrErrorText(params.assistantReply)) {
      logger.memory.warn('Attempted to save fallback/error reply, skipping save');
      return;
    }

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

    // 2. Persist to PostgreSQL if database pool is available
    if (getDbPool()) {
      try {
        await saveSuccessfulTurn(params);
      } catch (err) {
        logger.database.warn('[DATABASE] unavailable - turn saved to in-memory only:', (err as Error).message);
      }
    }

    memoryDiagnostics.lastMemorySaveAt = new Date().toISOString();
    logger.memory.info('[memory] saved conversation pair');
  }

  /**
   * Delete conversation from both database and in-memory cache.
   */
  async deleteConversation(chatId: string): Promise<boolean> {
    this.clearHistory(chatId);

    if (getDbPool()) {
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
