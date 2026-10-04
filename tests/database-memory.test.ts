/**
 * Test Suite for PostgreSQL Persistent Memory, Schema, and Transactional Conversation Storage.
 *
 * Verifies all 22 required behaviors:
 * 1. conversation created
 * 2. successful user message saved
 * 3. successful assistant response saved
 * 4. failed AI message not saved
 * 5. fallback error not saved
 * 6. duplicate message_id rejected safely
 * 7. recent history returns correct limit
 * 8. recent history chronological
 * 9. private chats isolated
 * 10. groups isolated
 * 11. memory survives simulated service restart
 * 12. summary stored
 * 13. summary updated
 * 14. relevant old history retrieved
 * 15. relevant history does not duplicate recent history
 * 16. delete single conversation works
 * 17. delete all requires confirmation
 * 18. DB failure does not crash bot
 * 19. parameterized query behavior
 * 20. DB pool reused
 * 21. assistant filtered response stored
 * 22. unprocessed group messages not persisted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { setTestDbPool, isDatabaseConnected, getDbPool, query } from '../src/database/db';
import { ensureSchema } from '../src/database/schema';
import {
  getOrCreateConversation,
  getConversationByChatId,
  deleteConversation,
  deleteAllConversations,
} from '../src/database/conversations';
import {
  saveSuccessfulTurn,
  getRecentHistory,
  searchRelevantOldMessages,
  getConversationSummary,
  saveConversationSummary,
  loadConversationContext,
  buildFactualSummary,
} from '../src/database/memoryRepository';
import { memory } from '../src/services/memory';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { adminRouter } from '../src/routes/admin';
import * as whatsappService from '../src/services/whatsapp';
import * as geminiService from '../src/services/gemini';
import { config } from '../src/config';
import { IncomingMessage } from '../src/types/whatsapp';

/**
 * In-memory Mock PostgreSQL Database Engine
 */
function createMockPostgresPool(): { pool: Pool; client: PoolClient; data: any } {
  const data = {
    conversations: [] as Array<{
      id: number;
      chat_id: string;
      chat_type: string;
      created_at: Date;
      updated_at: Date;
      last_message_at: Date;
    }>,
    messages: [] as Array<{
      id: number;
      conversation_id: number;
      message_id: string | null;
      sender_id: string | null;
      role: 'user' | 'assistant';
      content: string;
      model_used: string | null;
      task_type: string | null;
      created_at: Date;
    }>,
    conversation_memories: [] as Array<{
      id: number;
      conversation_id: number;
      summary: string;
      message_count: number;
      created_at: Date;
      updated_at: Date;
    }>,
    inTransaction: false,
    queryLogs: [] as Array<{ text: string; params?: any[] }>,
  };

  let nextConvId = 1;
  let nextMsgId = 1;
  let nextMemId = 1;

  const executeSql = async (sql: string, params: any[] = []): Promise<any> => {
    data.queryLogs.push({ text: sql, params });
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    if (cleanSql.includes('SELECT 1')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (cleanSql.includes('BEGIN')) {
      data.inTransaction = true;
      return { rows: [], rowCount: 0 };
    }

    if (cleanSql.includes('COMMIT')) {
      data.inTransaction = false;
      return { rows: [], rowCount: 0 };
    }

    if (cleanSql.includes('ROLLBACK')) {
      data.inTransaction = false;
      return { rows: [], rowCount: 0 };
    }

    if (cleanSql.includes('CREATE TABLE') || cleanSql.includes('CREATE INDEX')) {
      return { rows: [], rowCount: 0 };
    }

    // INSERT INTO conversations
    if (cleanSql.includes('INSERT INTO conversations')) {
      const chatId = params[0];
      const chatType = params[1] || 'private';
      let existing = data.conversations.find((c) => c.chat_id === chatId);
      if (existing) {
        existing.updated_at = new Date();
        return { rows: [existing], rowCount: 1 };
      }
      const newConv = {
        id: nextConvId++,
        chat_id: chatId,
        chat_type: chatType,
        created_at: new Date(),
        updated_at: new Date(),
        last_message_at: new Date(),
      };
      data.conversations.push(newConv);
      return { rows: [newConv], rowCount: 1 };
    }

    // SELECT FROM conversations WHERE chat_id
    if (cleanSql.startsWith('SELECT') && cleanSql.includes('FROM conversations WHERE chat_id = $1')) {
      const chatId = params[0];
      const found = data.conversations.find((c) => c.chat_id === chatId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    // UPDATE conversations SET last_message_at
    if (cleanSql.includes('UPDATE conversations SET last_message_at')) {
      const convId = params[0];
      const conv = data.conversations.find((c) => c.id === convId);
      if (conv) {
        conv.last_message_at = new Date();
        conv.updated_at = new Date();
      }
      return { rows: [], rowCount: 1 };
    }

    // DELETE FROM conversations WHERE chat_id = $1
    if (cleanSql.includes('DELETE FROM conversations WHERE chat_id = $1')) {
      const chatId = params[0];
      const idx = data.conversations.findIndex((c) => c.chat_id === chatId);
      if (idx !== -1) {
        const conv = data.conversations[idx];
        data.conversations.splice(idx, 1);
        data.messages = data.messages.filter((m) => m.conversation_id !== conv.id);
        data.conversation_memories = data.conversation_memories.filter((cm) => cm.conversation_id !== conv.id);
        return { rows: [{ id: conv.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // DELETE FROM conversations (All)
    if (cleanSql === 'DELETE FROM conversations;' || cleanSql === 'DELETE FROM conversations') {
      const count = data.conversations.length;
      data.conversations = [];
      data.messages = [];
      data.conversation_memories = [];
      return { rows: [], rowCount: count };
    }

    // INSERT INTO messages (user)
    if (cleanSql.includes("INSERT INTO messages") && cleanSql.includes("'user'")) {
      const convId = params[0];
      const messageId = params[1] || null;
      const senderId = params[2] || null;
      const content = params[3];

      if (messageId && data.messages.some((m) => m.message_id === messageId)) {
        // ON CONFLICT DO NOTHING
        return { rows: [], rowCount: 0 };
      }

      const msg = {
        id: nextMsgId++,
        conversation_id: convId,
        message_id: messageId,
        sender_id: senderId,
        role: 'user' as const,
        content,
        model_used: null,
        task_type: null,
        created_at: new Date(),
      };
      data.messages.push(msg);
      return { rows: [msg], rowCount: 1 };
    }

    // INSERT INTO messages (assistant)
    if (cleanSql.includes("INSERT INTO messages") && cleanSql.includes("'assistant'")) {
      const convId = params[0];
      const content = params[1];
      const modelUsed = params[2] || null;
      const taskType = params[3] || null;

      const msg = {
        id: nextMsgId++,
        conversation_id: convId,
        message_id: null,
        sender_id: null,
        role: 'assistant' as const,
        content,
        model_used: modelUsed,
        task_type: taskType,
        created_at: new Date(),
      };
      data.messages.push(msg);
      return { rows: [msg], rowCount: 1 };
    }

    // SELECT COUNT(*) as count FROM messages WHERE conversation_id
    if (cleanSql.includes('COUNT(*) as count FROM messages')) {
      const convId = params[0];
      const count = data.messages.filter((m) => m.conversation_id === convId).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    // SELECT messages ORDER BY created_at DESC LIMIT
    if (cleanSql.includes('SELECT id, role, content, created_at FROM messages') && cleanSql.includes('ORDER BY created_at DESC')) {
      const convId = params[0];
      const limit = params[1];
      const msgs = data.messages
        .filter((m) => m.conversation_id === convId)
        .slice(-limit)
        .reverse();
      return { rows: msgs, rowCount: msgs.length };
    }

    // SELECT id FROM messages WHERE message_id = $1
    if (cleanSql.includes('FROM messages WHERE message_id = $1')) {
      const msgId = params[0];
      const found = data.messages.filter((m) => m.message_id === msgId);
      return { rows: found, rowCount: found.length };
    }

    // SELECT messages with Full-Text Search
    if (cleanSql.includes('to_tsvector') && cleanSql.includes('messages')) {
      const convId = params[0];
      const queryText = (params[1] || '').toLowerCase();
      const excludeIds = params[2] || [];
      const limit = params[3] || 6;

      const matched = data.messages.filter((m) => {
        if (m.conversation_id !== convId) return false;
        if (Array.isArray(excludeIds) && excludeIds.includes(m.id)) return false;
        // Simple mock full-text keyword matching
        const words = queryText.split(/\s+/).filter(Boolean);
        return words.some((w: string) => m.content.toLowerCase().includes(w));
      }).slice(0, limit);

      return { rows: matched, rowCount: matched.length };
    }

    // conversation_memories queries
    if (cleanSql.includes('FROM conversation_memories WHERE conversation_id')) {
      const convId = params[0];
      const mem = data.conversation_memories.find((m) => m.conversation_id === convId);
      return { rows: mem ? [mem] : [], rowCount: mem ? 1 : 0 };
    }

    if (cleanSql.includes('INSERT INTO conversation_memories')) {
      const convId = params[0];
      const summary = params[1];
      const messageCount = params[2];
      let mem = data.conversation_memories.find((m) => m.conversation_id === convId);
      if (mem) {
        mem.summary = summary;
        mem.message_count = messageCount;
        mem.updated_at = new Date();
      } else {
        mem = {
          id: nextMemId++,
          conversation_id: convId,
          summary,
          message_count: messageCount,
          created_at: new Date(),
          updated_at: new Date(),
        };
        data.conversation_memories.push(mem);
      }
      return { rows: [mem], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  const client: any = {
    query: vi.fn(executeSql),
    release: vi.fn(),
  };

  const pool: any = {
    query: vi.fn(executeSql),
    connect: vi.fn(async () => client),
    on: vi.fn(),
    end: vi.fn(async () => {}),
  };

  return { pool, client, data };
}

describe('PostgreSQL Persistent Memory Suite', () => {
  let mockDb: ReturnType<typeof createMockPostgresPool>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockDb = createMockPostgresPool();
    setTestDbPool(mockDb.pool);
    memory.clearAll();
    await ensureSchema(mockDb.pool);
  });

  afterEach(() => {
    setTestDbPool(null);
  });

  // 1. conversation created
  it('1. creates a new conversation row on demand', async () => {
    const conv = await getOrCreateConversation('628111@s.whatsapp.net', 'private');
    expect(conv).toBeDefined();
    expect(conv.chat_id).toBe('628111@s.whatsapp.net');
    expect(conv.chat_type).toBe('private');
    expect(mockDb.data.conversations.length).toBe(1);
  });

  // 2. successful user message saved
  // 3. successful assistant response saved
  it('2 & 3. saves both user prompt and assistant reply in a transaction upon success', async () => {
    await saveSuccessfulTurn({
      chatId: '628111@s.whatsapp.net',
      isGroup: false,
      userMessageId: 'msg-001',
      userPrompt: 'Halo bot',
      assistantReply: 'Halo! Ada yang bisa dibantu?',
      modelUsed: 'gemini-38',
      taskType: 'general',
    });

    expect(mockDb.data.messages.length).toBe(2);
    expect(mockDb.data.messages[0].role).toBe('user');
    expect(mockDb.data.messages[0].content).toBe('Halo bot');
    expect(mockDb.data.messages[1].role).toBe('assistant');
    expect(mockDb.data.messages[1].content).toBe('Halo! Ada yang bisa dibantu?');
    expect(mockDb.data.messages[1].model_used).toBe('gemini-38');
  });

  // 4. failed AI message not saved
  // 5. fallback error not saved
  it('4 & 5. does not save failed prompt or fallback error text into database', async () => {
    vi.spyOn(geminiService, 'generateReply').mockRejectedValue(new Error('503 Service Unavailable'));
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    const msg: IncomingMessage = {
      chatId: '628999@s.whatsapp.net',
      senderId: '628999@s.whatsapp.net',
      senderName: 'Udin',
      text: 'Prompt yang gagal',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'fail-turn-1',
      mentionedIds: [],
    };

    await processIncomingMessage(msg);

    // Database messages should remain empty
    expect(mockDb.data.messages.length).toBe(0);
    // In-memory history should also remain empty
    expect(memory.getHistory('628999@s.whatsapp.net')).toHaveLength(0);
  });

  // 6. duplicate message_id rejected safely
  it('6. duplicate message_id is safely ignored without crashing', async () => {
    await saveSuccessfulTurn({
      chatId: '628111@s.whatsapp.net',
      isGroup: false,
      userMessageId: 'unique-msg-123',
      userPrompt: 'Pesan pertama',
      assistantReply: 'Balasan pertama',
    });

    expect(mockDb.data.messages.length).toBe(2);

    // Duplicate save attempt
    await saveSuccessfulTurn({
      chatId: '628111@s.whatsapp.net',
      isGroup: false,
      userMessageId: 'unique-msg-123',
      userPrompt: 'Pesan duplikat',
      assistantReply: 'Balasan duplikat',
    });

    // User message with same message_id should not duplicate
    const userMsgs = mockDb.data.messages.filter((m: any) => m.role === 'user');
    expect(userMsgs.length).toBe(1);
  });

  // 7. recent history returns correct limit
  // 8. recent history chronological
  it('7 & 8. returns recent history limited to MAX_HISTORY_MESSAGES in chronological order', async () => {
    const conv = await getOrCreateConversation('628555@s.whatsapp.net', 'private');

    for (let i = 1; i <= 5; i++) {
      mockDb.data.messages.push({
        id: i,
        conversation_id: conv.id,
        message_id: `m-${i}`,
        sender_id: null,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Pesan ke-${i}`,
        model_used: null,
        task_type: null,
        created_at: new Date(1000 * i),
      });
    }

    const { entries } = await getRecentHistory(conv.id, 3);
    expect(entries.length).toBe(3);
    // Chronological: oldest to newest
    expect(entries[0].content).toBe('Pesan ke-3');
    expect(entries[1].content).toBe('Pesan ke-4');
    expect(entries[2].content).toBe('Pesan ke-5');
  });

  // 9. private chats isolated
  // 10. groups isolated
  it('9 & 10. strictly isolates private chats and group chats', async () => {
    await saveSuccessfulTurn({
      chatId: 'user_a@s.whatsapp.net',
      isGroup: false,
      userPrompt: 'Rahasia User A',
      assistantReply: 'Jawaban A',
    });

    await saveSuccessfulTurn({
      chatId: 'group_b@g.us',
      isGroup: true,
      userPrompt: 'Pesan Group B',
      assistantReply: 'Jawaban Group B',
    });

    const contextA = await loadConversationContext('user_a@s.whatsapp.net', 'cek');
    const contextB = await loadConversationContext('group_b@g.us', 'cek');

    expect(contextA.recentHistory[0].content).toBe('Rahasia User A');
    expect(contextA.recentHistory.some((m) => m.content.includes('Group B'))).toBe(false);

    expect(contextB.recentHistory[0].content).toBe('Pesan Group B');
    expect(contextB.recentHistory.some((m) => m.content.includes('User A'))).toBe(false);
  });

  // 11. memory survives simulated service restart
  it('11. memory is restored from PostgreSQL after simulated service restart (empty memory map)', async () => {
    await saveSuccessfulTurn({
      chatId: 'persisted_user@s.whatsapp.net',
      isGroup: false,
      userPrompt: 'Nama saya Budi',
      assistantReply: 'Halo Budi!',
    });

    // Simulate server reboot / in-memory store wiped
    memory.clearHistory('persisted_user@s.whatsapp.net');
    expect(memory.getHistory('persisted_user@s.whatsapp.net')).toHaveLength(0);

    // Incoming context load re-populates from database
    const context = await memory.loadContext('persisted_user@s.whatsapp.net', 'Siapa saya?');
    expect(context.recentHistory).toHaveLength(2);
    expect(context.recentHistory[0].content).toBe('Nama saya Budi');
    expect(context.recentHistory[1].content).toBe('Halo Budi!');
  });

  // 12. summary stored
  // 13. summary updated
  it('12 & 13. stores and updates long-term memory summary when threshold is reached', async () => {
    const conv = await getOrCreateConversation('summary_test@s.whatsapp.net', 'private');
    await saveConversationSummary(conv.id, 'User bernama Budi dan menyukai kopi', 10);

    const summaryRecord = await getConversationSummary(conv.id);
    expect(summaryRecord?.summary).toBe('User bernama Budi dan menyukai kopi');

    // Update summary
    await saveConversationSummary(conv.id, 'User bernama Budi, menyukai kopi dan tinggal di Bandung', 25);
    const updated = await getConversationSummary(conv.id);
    expect(updated?.summary).toBe('User bernama Budi, menyukai kopi dan tinggal di Bandung');
    expect(updated?.messageCount).toBe(25);
  });

  // 14. relevant old history retrieved
  // 15. relevant history does not duplicate recent history
  it('14 & 15. retrieves relevant old messages via search and avoids duplicating recent history', async () => {
    const conv = await getOrCreateConversation('search_test@s.whatsapp.net', 'private');

    // Add old messages
    mockDb.data.messages.push({
      id: 1,
      conversation_id: conv.id,
      message_id: 'm1',
      sender_id: null,
      role: 'user',
      content: 'Proyek kita menggunakan framework Next.js dan Tailwind',
      model_used: null,
      task_type: null,
      created_at: new Date(1000),
    });

    // Add recent message
    mockDb.data.messages.push({
      id: 2,
      conversation_id: conv.id,
      message_id: 'm2',
      sender_id: null,
      role: 'user',
      content: 'Bagaimana perkembangan framework kita tadi?',
      model_used: null,
      task_type: null,
      created_at: new Date(2000),
    });

    // Exclude recent id 2 from search
    const results = await searchRelevantOldMessages(conv.id, 'framework Next.js', [2], 6);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('Proyek kita menggunakan framework Next.js');
  });

  // 16. delete single conversation works
  it('16. deletes single conversation and cascades to messages and memories', async () => {
    await saveSuccessfulTurn({
      chatId: 'to_delete@s.whatsapp.net',
      isGroup: false,
      userPrompt: 'Hapus saya',
      assistantReply: 'Baik',
    });

    const deleted = await deleteConversation('to_delete@s.whatsapp.net');
    expect(deleted).toBe(true);

    const found = await getConversationByChatId('to_delete@s.whatsapp.net');
    expect(found).toBeNull();
    expect(mockDb.data.messages.length).toBe(0);
  });

  // 17. delete all requires confirmation
  it('17. admin delete all memory requires explicit confirmation body', async () => {
    (config as any).adminToken = 'test-admin-token';

    let capturedStatus = 0;
    let capturedJson: any = null;

    const mockRes: any = {
      status: vi.fn((code: number) => {
        capturedStatus = code;
        return mockRes;
      }),
      json: vi.fn((obj: any) => {
        capturedJson = obj;
        return mockRes;
      }),
    };

    // Case A: Missing confirm body -> 400
    const mockReqBad: any = {
      headers: { 'x-admin-token': 'test-admin-token' },
      query: {},
      body: {},
    };

    // Find delete route handler in adminRouter stack
    const deleteRoute = (adminRouter as any).stack.find(
      (layer: any) => layer.route && layer.route.path === '/memory' && layer.route.methods.delete
    );

    // Call verifyAdminToken then route handler
    const handlers = deleteRoute.route.stack.map((s: any) => s.handle);
    const verifyTokenMiddleware = handlers[0];
    const deleteHandler = handlers[1];

    let nextCalled = false;
    verifyTokenMiddleware(mockReqBad, mockRes, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);

    await deleteHandler(mockReqBad, mockRes);
    expect(capturedStatus).toBe(400);
    expect(capturedJson.error).toContain('Confirmation required');

    // Case B: Valid confirm body -> 200
    const mockReqGood: any = {
      headers: { 'x-admin-token': 'test-admin-token' },
      query: {},
      body: { confirm: 'DELETE_ALL_MEMORY' },
    };

    await deleteHandler(mockReqGood, mockRes);
    expect(capturedStatus).toBe(200);
    expect(capturedJson.deleted).toBe(true);
    expect(capturedJson.all).toBe(true);
  });

  // 18. DB failure does not crash bot
  it('18. temporary database failure does not crash the bot and gracefully falls back', async () => {
    // Break DB pool
    setTestDbPool(null);
    expect(isDatabaseConnected()).toBe(false);

    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Jawaban fallback in-memory');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    const msg: IncomingMessage = {
      chatId: 'offline_db@s.whatsapp.net',
      senderId: 'offline_db@s.whatsapp.net',
      senderName: 'Udin',
      text: 'Halo walau db mati',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'db-offline-1',
      mentionedIds: [],
    };

    const handled = await processIncomingMessage(msg);
    expect(handled).toBe(true);

    // In-memory memory still receives the turn
    expect(memory.getHistory('offline_db@s.whatsapp.net')).toHaveLength(2);
  });

  // 19. parameterized query behavior
  it('19. enforces parameterized queries ($1, $2) and prevents SQL injection characters', async () => {
    const maliciousChatId = "malicious'; DROP TABLE messages; --";
    await getOrCreateConversation(maliciousChatId, 'private');

    const lastLog = mockDb.data.queryLogs[mockDb.data.queryLogs.length - 1];
    expect(lastLog.text).toContain('$1');
    expect(lastLog.params?.[0]).toBe(maliciousChatId);
    expect(mockDb.data.conversations[0].chat_id).toBe(maliciousChatId);
  });

  // 20. DB pool reused
  it('20. reuses singleton pool instance instead of creating new connections per message', () => {
    const pool1 = getDbPool();
    const pool2 = getDbPool();
    expect(pool1).toBe(pool2);
  });

  // 21. assistant filtered response stored
  it('21. stores profanity-filtered assistant response into persistent memory', async () => {
    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Kamu ini memang anjing');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    const msg: IncomingMessage = {
      chatId: 'profanity_db@s.whatsapp.net',
      senderId: 'profanity_db@s.whatsapp.net',
      senderName: 'Budi',
      text: 'halo',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'prof-turn-1',
      mentionedIds: [],
    };

    await processIncomingMessage(msg);

    const assistantMsg = mockDb.data.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toContain('a****g');
    expect(assistantMsg?.content).not.toContain('anjing');
  });

  // 22. unprocessed group messages not persisted
  it('22. group message without bot mention is ignored and NOT persisted to database', async () => {
    const msg: IncomingMessage = {
      chatId: 'unmentioned_group@g.us',
      senderId: 'user123@s.whatsapp.net',
      senderName: 'User',
      text: 'Halo semua di grup tanpa bot mention',
      timestamp: Date.now(),
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'group-unmentioned-1',
      mentionedIds: [],
    };

    const processed = await processIncomingMessage(msg);
    expect(processed).toBe(false);
    expect(mockDb.data.messages.length).toBe(0);
    expect(mockDb.data.conversations.length).toBe(0);
  });
});
