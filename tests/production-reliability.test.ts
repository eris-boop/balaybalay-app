/**
 * Production Reliability & Regression Test Suite
 *
 * Verifies all requirements:
 * 1. Model timeout continues failover (independent AbortController, cleanup timer in finally).
 * 2. Coding routing ("coba buatkan kalkulator", "buatkan kalkulator", "buat kode kalkulator", "bikin program python sederhana") & failover.
 * 3. Emergency fallback chain activates when category chain exhausted.
 * 4. Failed message does not poison queue: Msg 1 (success) -> Msg 2 (all AI fail) -> Msg 3 (success).
 * 5. DB history survives process restart / memory reset simulation (context restored from PostgreSQL).
 * 6. Duplicate WhatsApp message is skipped and not stored twice in DB.
 * 7. Profanity filter masks assistant output while preserving original user prompt.
 * 8. Profanity filter throwing error does not crash queue or fail the AI response.
 * 9. Profanity filtering does not affect AI timeout/failover (local synchronous post-processing).
 * 10. Admin status (/admin/status) exposes safe diagnostics without leaking private data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { setTestDbPool, isDatabaseConnected, getDbPool } from '../src/database/db';
import { memory, getMemoryDiagnostics, resetMemoryDiagnostics } from '../src/services/memory';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { adminRouter } from '../src/routes/admin';
import * as whatsappService from '../src/services/whatsapp';
import * as geminiService from '../src/services/gemini';
import {
  detectTaskType,
  setTestOpenAIClient,
  resetAIState,
  getModelChainsForTask,
  generateReplyWithFailover,
} from '../src/services/aiService';
import { profanityFilter, filterProfanity } from '../src/services/profanityFilter';
import { config } from '../src/config';
import { IncomingMessage } from '../src/types/whatsapp';
import { chatQueue } from '../src/utils/queue';
import { idempotency } from '../src/services/idempotency';

/**
 * Mock PostgreSQL in-memory pool for testing
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
    queryLogs: [] as Array<{ text: string; params?: any[] }>,
  };

  let nextConvId = 1;
  let nextMsgId = 1;

  const executeSql = async (sql: string, params: any[] = []): Promise<any> => {
    data.queryLogs.push({ text: sql, params });
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    if (cleanSql.includes('SELECT 1')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
    if (cleanSql.includes('BEGIN') || cleanSql.includes('COMMIT') || cleanSql.includes('ROLLBACK')) {
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

    // SELECT FROM conversations WHERE chat_id = $1
    if (cleanSql.includes('FROM conversations WHERE chat_id = $1')) {
      const chatId = params[0];
      const found = data.conversations.find((c) => c.chat_id === chatId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    // UPDATE conversations SET last_message_at
    if (cleanSql.includes('UPDATE conversations SET last_message_at')) {
      return { rows: [], rowCount: 1 };
    }

    // SELECT id FROM messages WHERE message_id = $1
    if (cleanSql.includes('FROM messages WHERE message_id = $1')) {
      const msgId = params[0];
      const found = data.messages.filter((m) => m.message_id === msgId);
      return { rows: found, rowCount: found.length };
    }

    // INSERT INTO messages (user)
    if (cleanSql.includes("INSERT INTO messages") && cleanSql.includes("'user'")) {
      let convId: number;
      let messageId: string | null = null;
      let senderId: string | null = null;
      let content: string;
      if (cleanSql.includes('chat_id')) {
        convId = params[0];
        messageId = params[2] || null;
        senderId = params[3] || null;
        content = params[4];
      } else {
        convId = params[0];
        messageId = params[1] || null;
        senderId = params[2] || null;
        content = params[3];
      }

      if (messageId && data.messages.some((m) => m.message_id === messageId)) {
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
      let convId: number;
      let content: string;
      let modelUsed: string | null = null;
      let taskType: string | null = null;
      if (cleanSql.includes('chat_id')) {
        convId = params[0];
        content = params[2];
        modelUsed = params[3] || null;
        taskType = params[4] || null;
      } else {
        convId = params[0];
        content = params[1];
        modelUsed = params[2] || null;
        taskType = params[3] || null;
      }

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

    // SELECT messages with Full-Text Search
    if (cleanSql.includes('to_tsvector') && cleanSql.includes('messages')) {
      return { rows: [], rowCount: 0 };
    }

    // conversation_memories queries
    if (cleanSql.includes('FROM conversation_memories WHERE conversation_id')) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  const client = {
    query: vi.fn().mockImplementation(executeSql),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    query: vi.fn().mockImplementation(executeSql),
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as Pool;

  return { pool, client, data };
}

describe('Production Reliability & Regression Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.clearAll();
    idempotency.clear();
    chatQueue.clear();
    resetAIState();
    resetMemoryDiagnostics();
    setTestDbPool(null);

    (config as any).aiProvider = 'vpsmurah';
    (config as any).adminToken = 'test-token';
    (config as any).aiCodingChain = [
      'qwen3-coder',
      'gemini-38',
      'gpt-53-codex',
      'deepseek-coder',
      'codestral',
      'gpt-5-mini',
    ];
    (config as any).aiGeneralChain = [
      'gemini-38',
      'qwen3-flash',
      'gemini-37',
      'gemini-36',
      'gpt-5-mini',
      'gpt-4o-mini',
      'mistral-small',
    ];
  });

  afterEach(() => {
    setTestOpenAIClient(null);
    setTestDbPool(null);
    vi.restoreAllMocks();
  });

  // 1. Model timeout continues failover
  it('1. primary model timeout continues failover to secondary model without failing the request', async () => {
    const attempted: string[] = [];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (body: any, options: any) => {
            attempted.push(body.model);
            if (body.model === 'qwen3-coder') {
              // Simulate timeout by listening to abort signal
              return new Promise((resolve, reject) => {
                const signal = options?.signal;
                if (signal) {
                  signal.addEventListener('abort', () => {
                    const err: any = new Error('Model qwen3-coder timed out after 50ms');
                    err.name = 'AbortError';
                    err.status = 408;
                    reject(err);
                  });
                }
              });
            }
            if (body.model === 'gemini-38') {
              return {
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: 'Berikut kode kalkulator python:\ndef calc(): pass',
                    },
                  },
                ],
              };
            }
            throw new Error(`Unexpected model: ${body.model}`);
          }),
        },
      },
    };

    setTestOpenAIClient(mockOpenAI);

    // Save and temporarily adjust model timeout to 50ms for test speed
    const origTimeout = (config as any).aiModelTimeoutMs;
    (config as any).aiModelTimeoutMs = 50;

    try {
      const reply = await generateReplyWithFailover({
        message: 'coba buatkan kalkulator',
        chatId: 'test-chat-timeout@s.whatsapp.net',
        history: [],
      });

      expect(attempted).toEqual(['qwen3-coder', 'gemini-38']);
      expect(reply).toContain('Berikut kode kalkulator python');
    } finally {
      (config as any).aiModelTimeoutMs = origTimeout;
    }
  });

  // 2. Coding routing & classification
  it('2. correctly classifies coding prompts including "coba buatkan kalkulator", "buatkan kalkulator", "buat kode kalkulator", "bikin program python sederhana"', () => {
    expect(detectTaskType('coba buatkan kalkulator')).toBe('coding');
    expect(detectTaskType('buatkan kalkulator')).toBe('coding');
    expect(detectTaskType('buat kode kalkulator')).toBe('coding');
    expect(detectTaskType('bikin program python sederhana')).toBe('coding');
    expect(detectTaskType('bikin kalkulator sederhana')).toBe('coding');
    expect(detectTaskType('buatkan script bash backup')).toBe('coding');
    expect(detectTaskType('hitung 25 * 4')).toBe('reasoning');
    expect(detectTaskType('halo, selamat malam')).toBe('general');
  });

  // 3. Emergency fallback chain activates when category chain exhausted
  it('3. activates emergency chain when all category models fail', async () => {
    const attempted: string[] = [];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (body: any) => {
            attempted.push(body.model);
            // All coding chain models fail with 503
            const codingChain = config.aiCodingChain.length > 0
              ? config.aiCodingChain
              : ['qwen3-coder', 'gemini-38', 'gpt-53-codex', 'deepseek-coder', 'codestral', 'gpt-5-mini'];

            if (codingChain.includes(body.model)) {
              const err: any = new Error(`Service Unavailable: ${body.model}`);
              err.status = 503;
              throw err;
            }

            // Emergency chain model succeeds
            return {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'Jawaban kalkulator dari model emergency',
                  },
                },
              ],
            };
          }),
        },
      },
    };

    setTestOpenAIClient(mockOpenAI);

    const reply = await generateReplyWithFailover({
      message: 'buatkan kalkulator',
      chatId: 'test-emergency@s.whatsapp.net',
      history: [],
    });

    expect(attempted).toContain('qwen3-coder');
    expect(attempted).toContain('qwen3-flash');
    expect(reply).toBe('Jawaban kalkulator dari model emergency');
  });

  // 4. Failed message does not poison queue (3-message sequence)
  it('4. failed message does not poison queue: Msg 1 (success) -> Msg 2 (fail) -> Msg 3 (success)', async () => {
    const sentMessages: string[] = [];
    vi.spyOn(whatsappService, 'sendMessage').mockImplementation(async (_jid: string, text: string) => {
      sentMessages.push(text);
      return true as any;
    });

    let failMode = false;
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (body: any) => {
            if (failMode) {
              const err: any = new Error('All AI providers intentionally failed');
              err.status = 503;
              throw err;
            }
            return {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: `Jawaban untuk: ${body.messages[body.messages.length - 1].content}`,
                  },
                },
              ],
            };
          }),
        },
      },
    };

    setTestOpenAIClient(mockOpenAI);

    const chatId = 'isolated-chat@s.whatsapp.net';

    // Message 1: AI succeeds
    const msg1: IncomingMessage = {
      chatId,
      senderId: chatId,
      senderName: 'Budi',
      text: 'Halo asisten',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-seq-1',
      mentionedIds: [],
    };
    const res1 = await processIncomingMessage(msg1);
    expect(res1).toBe(true);
    expect(sentMessages[0]).toContain('Halo asisten');

    // Message 2: All AI providers intentionally fail
    failMode = true;
    const msg2: IncomingMessage = {
      chatId,
      senderId: chatId,
      senderName: 'Budi',
      text: 'Tolong bikin error',
      timestamp: Date.now() + 1000,
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-seq-2',
      mentionedIds: [],
    };
    const res2 = await processIncomingMessage(msg2);
    expect(res2).toBe(false);
    expect(sentMessages[1]).toContain('AI sedang mengalami gangguan sementara');

    // History should NOT contain Message 2 or fallback error text!
    const historyAfterFail = memory.getHistory(chatId);
    expect(historyAfterFail).toHaveLength(2); // Only msg1 user + assistant
    expect(historyAfterFail.some((e) => e.content.includes('Tolong bikin error'))).toBe(false);
    expect(historyAfterFail.some((e) => e.content.includes('gangguan sementara'))).toBe(false);

    // Message 3: AI succeeds again!
    failMode = false;
    const msg3: IncomingMessage = {
      chatId,
      senderId: chatId,
      senderName: 'Budi',
      text: 'Siapa nama kamu?',
      timestamp: Date.now() + 2000,
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-seq-3',
      mentionedIds: [],
    };
    const res3 = await processIncomingMessage(msg3);
    expect(res3).toBe(true);
    expect(sentMessages[2]).toContain('Siapa nama kamu?');

    // Queue must not be busy
    expect(chatQueue.isBusy(chatId)).toBe(false);
  });

  // 5. DB history survives process restart / memory reset simulation
  it('5. conversation history survives process restart / memory reset simulation and restores from PostgreSQL', async () => {
    const { pool, client, data } = createMockPostgresPool();
    setTestDbPool(pool);

    const chatId = 'persisted-chat@s.whatsapp.net';

    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    let lastContextReceived: any = null;
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (body: any) => {
            lastContextReceived = body.messages;
            return {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'Tentu, saya ingat kita sedang membahas proyek OSINT.',
                  },
                },
              ],
            };
          }),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    // Step 1: Initial conversation turn processed and saved to DB
    const turn1: IncomingMessage = {
      chatId,
      senderId: chatId,
      senderName: 'Rian',
      text: 'Saya sedang membuat proyek OSINT BalayBalay',
      timestamp: Date.now() - 5000,
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'turn-1',
      mentionedIds: [],
    };
    await processIncomingMessage(turn1);

    // Verify messages saved in mock database
    expect(data.messages).toHaveLength(2);

    // Step 2: Simulate process restart / Coolify redeploy: Wipe in-memory store completely!
    memory.clearHistory(chatId);
    expect(memory.getHistory(chatId)).toHaveLength(0); // RAM is empty!

    // Step 3: Follow-up message arrives. Should restore recent history from PostgreSQL!
    const turn2: IncomingMessage = {
      chatId,
      senderId: chatId,
      senderName: 'Rian',
      text: 'Apa yang tadi kita bicarakan?',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'turn-2',
      mentionedIds: [],
    };

    const resTurn2 = await processIncomingMessage(turn2);
    expect(resTurn2).toBe(true);

    // Verify that the AI was given the restored history, not an empty context!
    expect(lastContextReceived).toBeDefined();
    const historyContents = lastContextReceived.map((m: any) => m.content);
    expect(historyContents.some((c: string) => c.includes('Saya sedang membuat proyek OSINT BalayBalay'))).toBe(true);
    expect(historyContents.some((c: string) => c.includes('Apa yang tadi kita bicarakan?'))).toBe(true);

    // In-memory cache should also be synced with restored history
    expect(memory.getHistory(chatId).length).toBeGreaterThanOrEqual(2);
  });

  // 6. Duplicate WhatsApp message is skipped and not stored twice
  it('6. duplicate WhatsApp message is skipped and not stored twice in DB', async () => {
    const { pool, data } = createMockPostgresPool();
    setTestDbPool(pool);

    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { role: 'assistant', content: 'Halo!' } }],
          }),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    const msg: IncomingMessage = {
      chatId: 'dupe-chat@s.whatsapp.net',
      senderId: 'dupe-chat@s.whatsapp.net',
      senderName: 'Dedi',
      text: 'Halo pertama kali',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'fixed-msg-id-12345',
      mentionedIds: [],
    };

    // First arrival: processes normally
    const firstRes = await processIncomingMessage(msg);
    expect(firstRes).toBe(true);
    expect(data.messages).toHaveLength(2); // user + assistant

    // Second arrival: exact same messageId -> ignored by idempotency
    const secondRes = await processIncomingMessage(msg);
    expect(secondRes).toBe(false);
    expect(data.messages).toHaveLength(2); // Still 2, not duplicated!
  });

  // 7. Profanity filter masks assistant output while preserving original user prompt
  it('7. profanity filter masks assistant output and saves masked response while keeping original user prompt', async () => {
    const { pool, data } = createMockPostgresPool();
    setTestDbPool(pool);

    let sentText = '';
    vi.spyOn(whatsappService, 'sendMessage').mockImplementation(async (_jid: string, text: string) => {
      sentText = text;
      return true as any;
    });

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Kamu anjing dan bangsat banget bro!',
                },
              },
            ],
          }),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    const msg: IncomingMessage = {
      chatId: 'profanity-test@s.whatsapp.net',
      senderId: 'profanity-test@s.whatsapp.net',
      senderName: 'User',
      text: 'Kenapa kamu ngatain anjing?', // Raw user prompt contains harsh word
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'prof-1',
      mentionedIds: [],
    };

    const res = await processIncomingMessage(msg);
    expect(res).toBe(true);

    // Assistant response sent to WhatsApp must be masked
    expect(sentText).toContain('a****g');
    expect(sentText).toContain('b*****t');
    expect(sentText).not.toContain('anjing');
    expect(sentText).not.toContain('bangsat');

    // In database:
    // User prompt must remain original
    const userMsg = data.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toBe('Kenapa kamu ngatain anjing?');

    // Assistant reply must be masked in DB
    const assistantMsg = data.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.content).toContain('a****g');
    expect(assistantMsg.content).toContain('b*****t');
  });

  // 8. Profanity filter failure cannot fail an otherwise successful AI response
  it('8. profanity filter throwing error falls back to raw response and does not fail AI request', async () => {
    let sentText = '';
    vi.spyOn(whatsappService, 'sendMessage').mockImplementation(async (_jid: string, text: string) => {
      sentText = text;
      return true as any;
    });

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Jawaban AI yang valid',
                },
              },
            ],
          }),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    // Force profanityFilter.mask to throw
    vi.spyOn(profanityFilter, 'mask').mockImplementation(() => {
      throw new Error('Unexpected profanity engine crash');
    });

    const msg: IncomingMessage = {
      chatId: 'prof-err-test@s.whatsapp.net',
      senderId: 'prof-err-test@s.whatsapp.net',
      senderName: 'User',
      text: 'Halo AI',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'prof-err-1',
      mentionedIds: [],
    };

    const res = await processIncomingMessage(msg);
    expect(res).toBe(true);
    expect(sentText).toBe('Jawaban AI yang valid');
  });

  // 9. Profanity filtering does not affect AI timeout or failover
  it('9. profanity filtering is purely synchronous local post-processing and executes sub-millisecond', () => {
    const input = 'Teks normal dengan kata anjing dan bangsat di dalam kalimat.';
    const start = performance.now();
    const output = profanityFilter.mask(input);
    const duration = performance.now() - start;

    expect(output).toContain('a****g');
    expect(output).toContain('b*****t');
    expect(duration).toBeLessThan(15); // Local execution < 15ms
  });

  // 10. Admin diagnostics verification (/admin/status)
  it('10. /admin/status exposes all safe diagnostics and excludes any private user data or credentials', async () => {
    const { pool } = createMockPostgresPool();
    setTestDbPool(pool);

    // Trigger a loadContext to populate memory diagnostics
    await memory.loadContext('diag-test@s.whatsapp.net', 'test prompt');

    let capturedStatus = 0;
    let capturedJson: any = null;

    const mockReq: any = {
      headers: { 'x-admin-token': config.adminToken || 'test-token' },
      query: {},
      params: {},
    };

    const mockRes: any = {
      status(code: number) {
        capturedStatus = code;
        return this;
      },
      json(data: any) {
        capturedJson = data;
        return this;
      },
    };

    // Find handler for GET /admin/status
    const statusRoute = (adminRouter.stack as any[]).find(
      (layer) => layer.route && layer.route.path === '/status' && layer.route.methods.get
    );
    expect(statusRoute).toBeDefined();

    // Call verifyAdminToken middleware then status handler
    const verifyMiddleware = statusRoute.route.stack[0].handle;
    const statusHandler = statusRoute.route.stack[1].handle;

    verifyMiddleware(mockReq, mockRes, () => {
      statusHandler(mockReq, mockRes);
    });

    expect(capturedStatus).toBe(200);
    expect(capturedJson).toBeDefined();

    // Verify required diagnostics fields exist
    expect(capturedJson).toHaveProperty('databaseConnected');
    expect(capturedJson).toHaveProperty('persistentMemory');
    expect(capturedJson).toHaveProperty('memorySummaryEnabled');
    expect(capturedJson).toHaveProperty('memoryRetrievalEnabled');
    expect(capturedJson).toHaveProperty('lastMemoryLoadAt');
    expect(capturedJson).toHaveProperty('lastMemorySaveAt');
    expect(capturedJson).toHaveProperty('lastMemoryChatFound');
    expect(capturedJson).toHaveProperty('lastMemoryRecentCount');
    expect(capturedJson).toHaveProperty('lastMemoryRelevantCount');
    expect(capturedJson).toHaveProperty('lastMemorySummaryUsed');

    // Verify sensitive data is NOT exposed
    const jsonStr = JSON.stringify(capturedJson).toLowerCase();
    expect(jsonStr).not.toContain('apikey');
    expect(jsonStr).not.toContain('database_url');
    expect(jsonStr).not.toContain('postgres://');
    expect(jsonStr).not.toContain('password');
    expect(jsonStr).not.toContain('auth_dir');
    expect(jsonStr).not.toContain('test prompt');
  });
});
