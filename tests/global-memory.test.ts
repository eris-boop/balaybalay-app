/**
 * Global Shared Memory & Reliability Test Suite
 *
 * Verifies the 9 core specification tests:
 * TEST A: Group A information retrieved globally in Group B
 * TEST B: Private chat information retrieved globally in Group C
 * TEST C: Global memory survives process restart / RAM reset
 * TEST D: User message saved in PostgreSQL before AI call survives AI failure & restart
 * TEST E: Primary AI returns HTTP 200 with empty content -> failover to next model
 * TEST F: Primary AI returns finish_reason 'content_filter' -> failover to next model
 * TEST G: All primary category models fail -> emergency chain runs
 * TEST H: All VPSMurah models fail -> direct Gemini fallback runs
 * TEST I: Profanity filter throws -> queue continues & AI success not converted to provider error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { setTestDbPool } from '../src/database/db';
import { ensureSchema } from '../src/database/schema';
import {
  saveUserMessage,
  saveAssistantMessage,
  loadConversationContext,
  searchGlobalMessages,
} from '../src/database/memoryRepository';
import { memory } from '../src/services/memory';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { IncomingMessage } from '../src/types/whatsapp';
import * as whatsappService from '../src/services/whatsapp';
import * as whatsappClient from '../src/services/whatsappClient';
import * as aiService from '../src/services/aiService';
import * as geminiService from '../src/services/gemini';
import { profanityFilter } from '../src/services/profanityFilter';
import { setTestOpenAIClient, resetAIState } from '../src/services/aiService';
import { config } from '../src/config';

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
      chat_id: string | null;
      message_id: string | null;
      sender_id: string | null;
      role: 'user' | 'assistant';
      content: string;
      model_used: string | null;
      task_type: string | null;
      source_type: string;
      memory_eligible: boolean;
      created_at: Date;
    }>,
    conversation_memories: [] as any[],
    global_memory: [] as any[],
  };

  let nextConvId = 1;
  let nextMsgId = 1;

  const executeSql = async (sql: string, params: any[] = []): Promise<any> => {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    if (cleanSql.includes('SELECT 1')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
    if (cleanSql.includes('BEGIN') || cleanSql.includes('COMMIT') || cleanSql.includes('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('CREATE TABLE') || cleanSql.includes('CREATE INDEX') || cleanSql.includes('ALTER TABLE')) {
      return { rows: [], rowCount: 0 };
    }

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

    if (cleanSql.includes('FROM conversations WHERE chat_id = $1')) {
      const chatId = params[0];
      const found = data.conversations.find((c) => c.chat_id === chatId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    // INSERT INTO messages (user)
    if (cleanSql.includes('INSERT INTO messages') && cleanSql.includes("'user'")) {
      const convId = params[0];
      const chatId = params[1];
      const messageId = params[2] || null;
      const senderId = params[3] || null;
      const content = params[4];
      const sourceType = params[5] || 'private';

      if (messageId && data.messages.some((m) => m.message_id === messageId)) {
        return { rows: [], rowCount: 0 };
      }

      const msg = {
        id: nextMsgId++,
        conversation_id: convId,
        chat_id: chatId,
        message_id: messageId,
        sender_id: senderId,
        role: 'user' as const,
        content,
        model_used: null,
        task_type: null,
        source_type: sourceType,
        memory_eligible: true,
        created_at: new Date(),
      };
      data.messages.push(msg);
      return { rows: [msg], rowCount: 1 };
    }

    // INSERT INTO messages (assistant)
    if (cleanSql.includes('INSERT INTO messages') && cleanSql.includes("'assistant'")) {
      const convId = params[0];
      const chatId = params[1];
      const content = params[2];
      const modelUsed = params[3] || null;
      const taskType = params[4] || null;

      const msg = {
        id: nextMsgId++,
        conversation_id: convId,
        chat_id: chatId,
        message_id: null,
        sender_id: null,
        role: 'assistant' as const,
        content,
        model_used: modelUsed,
        task_type: taskType,
        source_type: 'assistant',
        memory_eligible: true,
        created_at: new Date(),
      };
      data.messages.push(msg);
      return { rows: [msg], rowCount: 1 };
    }

    if (cleanSql.includes('COUNT(*) as count FROM messages')) {
      const count = data.messages.length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    if (cleanSql.includes('SELECT id, role, content, created_at FROM messages') && cleanSql.includes('ORDER BY created_at DESC')) {
      const convId = params[0];
      const limit = params[1];
      const msgs = data.messages
        .filter((m) => m.conversation_id === convId)
        .slice(-limit)
        .reverse();
      return { rows: msgs, rowCount: msgs.length };
    }

    if (cleanSql.includes('to_tsvector') && cleanSql.includes('messages')) {
      if (cleanSql.includes('conversation_id !=')) {
        const queryText = (params[0] || '').toLowerCase();
        const convId = params[1];
        const excludeIds = params[2] || [];
        const limit = params[3] || 12;

        const matched = data.messages
          .filter((m) => {
            if (m.conversation_id === convId) return false;
            if (!m.memory_eligible) return false;
            if (Array.isArray(excludeIds) && excludeIds.includes(m.id)) return false;
            const words = queryText.split(/\s+/).filter(Boolean);
            return words.some((w: string) => m.content && m.content.toLowerCase().includes(w));
          })
          .slice(0, limit);

        return { rows: matched, rowCount: matched.length };
      } else if (cleanSql.includes('WHERE conversation_id = $1') || cleanSql.includes('WHERE conversation_id =')) {
        const convId = params[0];
        const queryText = (params[1] || '').toLowerCase();
        const excludeIds = params[2] || [];
        const limit = params[3] || 6;

        const matched = data.messages
          .filter((m) => {
            if (m.conversation_id !== convId) return false;
            if (!m.memory_eligible) return false;
            if (Array.isArray(excludeIds) && excludeIds.includes(m.id)) return false;
            const words = queryText.split(/\s+/).filter(Boolean);
            return words.some((w: string) => m.content && m.content.toLowerCase().includes(w));
          })
          .slice(0, limit);

        return { rows: matched, rowCount: matched.length };
      } else {
        const queryText = (params[0] || '').toLowerCase();
        const limit = params[1] || 12;

        const matched = data.messages
          .filter((m) => {
            if (!m.memory_eligible) return false;
            const words = queryText.split(/\s+/).filter(Boolean);
            return words.some((w: string) => m.content && m.content.toLowerCase().includes(w));
          })
          .slice(0, limit);

        return { rows: matched, rowCount: matched.length };
      }
    }

    if (cleanSql.includes('FROM global_memory')) {
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('FROM conversation_memories')) {
      return { rows: [], rowCount: 0 };
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

describe('Global Shared Memory Specification Suite', () => {
  let mockDb: ReturnType<typeof createMockPostgresPool>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetAIState();
    vi.spyOn(whatsappClient, 'getBotIdentifiers').mockReturnValue(['bot@s.whatsapp.net', '62812345678@s.whatsapp.net']);
    mockDb = createMockPostgresPool();
    setTestDbPool(mockDb.pool);
    memory.clearAll();
    await ensureSchema(mockDb.pool);
  });

  // TEST A: Group A info retrieved in Group B
  it('TEST A: Group A information ("Cia Fei suka Bryan") is retrieved globally in Group B', async () => {
    let capturedParams: any = null;
    vi.spyOn(geminiService, 'generateReply').mockImplementation(async (params: any) => {
      capturedParams = params;
      return 'Sebelumnya pernah ada informasi bahwa Cia Fei suka Bryan.';
    });
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    // Group A conversation
    const groupAMsg: IncomingMessage = {
      chatId: 'group_a@g.us',
      senderId: 'michael@s.whatsapp.net',
      senderName: 'Michael',
      text: '@bot Cia Fei suka Bryan',
      timestamp: Date.now() - 10000,
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-group-a-1',
      mentionedIds: ['bot@s.whatsapp.net'],
    };
    const resA = await processIncomingMessage(groupAMsg);
    expect(resA).toBe(true);

    // Group B conversation asks about it
    const groupBMsg: IncomingMessage = {
      chatId: 'group_b@g.us',
      senderId: 'sarah@s.whatsapp.net',
      senderName: 'Sarah',
      text: '@bot Cia Fei suka siapa?',
      timestamp: Date.now(),
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-group-b-1',
      mentionedIds: ['bot@s.whatsapp.net'],
    };
    const resB = await processIncomingMessage(groupBMsg);
    expect(resB).toBe(true);

    // Assert: Global relevant memory contains information from Group A
    expect(capturedParams).toBeDefined();
    expect(capturedParams.globalRelevantMessages).toBeDefined();
    expect(
      capturedParams.globalRelevantMessages.some((m: any) =>
        m.content.includes('Cia Fei suka Bryan')
      )
    ).toBe(true);
  });

  // TEST B: Private chat info retrieved in Group C
  it('TEST B: Private chat info ("Project utama namanya BalayBalay") is retrievable in Group C', async () => {
    let capturedParams: any = null;
    vi.spyOn(geminiService, 'generateReply').mockImplementation(async (params: any) => {
      capturedParams = params;
      return 'Berdasarkan informasi sebelumnya, nama project utama adalah BalayBalay.';
    });
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    // Private chat
    const privateMsg: IncomingMessage = {
      chatId: 'user_boss@s.whatsapp.net',
      senderId: 'user_boss@s.whatsapp.net',
      senderName: 'Boss',
      text: 'Project utama namanya BalayBalay.',
      timestamp: Date.now() - 10000,
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-private-1',
      mentionedIds: [],
    };
    await processIncomingMessage(privateMsg);

    // Later Group C asks
    const groupCMsg: IncomingMessage = {
      chatId: 'group_c@g.us',
      senderId: 'dev@s.whatsapp.net',
      senderName: 'Dev',
      text: '@bot Apa nama project utama?',
      timestamp: Date.now(),
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-group-c-1',
      mentionedIds: ['bot@s.whatsapp.net'],
    };
    await processIncomingMessage(groupCMsg);

    expect(capturedParams).toBeDefined();
    expect(
      capturedParams.globalRelevantMessages.some((m: any) =>
        m.content.includes('BalayBalay')
      )
    ).toBe(true);
  });

  // TEST C: Memory survives restart
  it('TEST C: Group A message survives restart / RAM wipe and is retrieved in Group B', async () => {
    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Tercatat');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    // Save in Group A
    const msgA: IncomingMessage = {
      chatId: 'group_a@g.us',
      senderId: 'user1@s.whatsapp.net',
      senderName: 'User 1',
      text: '@bot Bryan ulang tahun bulan Desember.',
      timestamp: Date.now() - 20000,
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-bday-1',
      mentionedIds: ['bot@s.whatsapp.net'],
    };
    await processIncomingMessage(msgA);

    // Simulate process reboot: RAM cache completely wiped
    memory.clearAll();

    // Query from Group B
    const contextGroupB = await loadConversationContext('group_b@g.us', 'Bryan ulang tahun kapan?');
    expect(
      contextGroupB.globalRelevantMessages.some((m) =>
        m.content.includes('Bryan ulang tahun bulan Desember')
      )
    ).toBe(true);
  });

  // TEST D: User message saved in PostgreSQL before AI call survives AI failure & restart
  it('TEST D: user message saved before AI survives AI provider failure & app restart', async () => {
    vi.spyOn(geminiService, 'generateReply').mockRejectedValue(new Error('AI Provider Crashed'));
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    const failMsg: IncomingMessage = {
      chatId: 'group_test@g.us',
      senderId: 'user_fail@s.whatsapp.net',
      senderName: 'User Fail',
      text: '@bot Fakta penting tersimpan sebelum crash',
      timestamp: Date.now(),
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-crash-1',
      mentionedIds: ['bot@s.whatsapp.net'],
    };

    const res = await processIncomingMessage(failMsg);
    expect(res).toBe(false); // AI failed

    // Verify it was saved in PostgreSQL
    const savedMsg = mockDb.data.messages.find(
      (m: any) => m.content.includes('Fakta penting tersimpan sebelum crash')
    );
    expect(savedMsg).toBeDefined();
    expect(savedMsg.role).toBe('user');

    // Simulate app restart
    memory.clearAll();

    // Search global messages directly from database
    const results = await searchGlobalMessages('Fakta penting tersimpan sebelum crash');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('Fakta penting tersimpan sebelum crash');
  });

  // TEST E: Primary AI returns HTTP 200 with empty content -> next model runs
  it('TEST E: primary AI returns empty content -> router fails over to next model', async () => {
    let callCount = 0;
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (body: any) => {
            callCount++;
            if (callCount === 1) {
              // HTTP 200 with empty string content
              return {
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: '',
                    },
                  },
                ],
              };
            }
            // Second model succeeds
            return {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'Balasan dari model kedua setelah failover',
                  },
                },
              ],
            };
          }),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    const reply = await aiService.generateReply({
      chatId: 'test_empty@s.whatsapp.net',
      message: 'Halo apa kabar?',
      history: [],
    });

    expect(reply).toBe('Balasan dari model kedua setelah failover');
    expect(callCount).toBe(2);
  });

  // TEST F: Primary gets content_filter -> next model runs
  it('TEST F: primary AI triggers content_filter -> router fails over to next model', async () => {
    let callCount = 0;
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (body: any) => {
            callCount++;
            if (callCount === 1) {
              return {
                choices: [
                  {
                    finish_reason: 'content_filter',
                    message: {
                      role: 'assistant',
                      content: null,
                    },
                  },
                ],
              };
            }
            return {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'Jawaban dari model pengganti',
                  },
                },
              ],
            };
          }),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    const reply = await aiService.generateReply({
      chatId: 'test_filter@s.whatsapp.net',
      message: 'Pertanyaan kesehatan reproduksi',
      history: [],
    });

    expect(reply).toBe('Jawaban dari model pengganti');
    expect(callCount).toBe(2);
  });

  // TEST G: All primary models fail -> emergency chain runs
  it('TEST G: all primary models fail -> emergency chain runs and succeeds', async () => {
    (config as any).aiEmergencyChain = ['qwen3-flash', 'gpt-5-mini', 'llama-4-scout'];
    const attemptedModels: string[] = [];
    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (body: any) => {
            attemptedModels.push(body.model);
            // Fail all primary models (e.g. gemini-38, qwen3-flash, etc.)
            if (body.model !== 'llama-4-scout') {
              throw new Error(`503 Service Unavailable for ${body.model}`);
            }
            return {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'Sukses dari emergency chain model',
                  },
                },
              ],
            };
          }),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    const reply = await aiService.generateReply({
      chatId: 'test_emergency@s.whatsapp.net',
      message: 'Halo bantuan darurat',
      history: [],
    });

    expect(reply).toBe('Sukses dari emergency chain model');
    expect(attemptedModels.length).toBeGreaterThan(2);
  });

  // TEST H: All VPSMurah models fail -> direct Gemini fallback runs
  it('TEST H: all VPSMurah models fail -> direct Gemini fallback runs', async () => {
    (config as any).aiDirectGeminiFallback = true;
    (config as any).geminiApiKey = 'test-gemini-key';

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('503 All VPSMurah nodes down')),
        },
      },
    };
    setTestOpenAIClient(mockOpenAI);

    geminiService.setTestGeminiDirectHandler(async () => 'Jawaban dari Google Gemini Direct');

    const reply = await geminiService.generateReply({
      chatId: 'test_direct_gemini@s.whatsapp.net',
      message: 'Halo direct fallback',
      history: [],
    });

    expect(reply).toBe('Jawaban dari Google Gemini Direct');
  });

  // TEST I: Profanity filter throws -> queue continues & AI success not converted to provider error
  it('TEST I: profanity filter error does not crash queue or convert AI success to failure', async () => {
    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Jawaban normal tanpa sensor');
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    // Mock profanityFilter.mask to throw unexpectedly
    vi.spyOn(profanityFilter, 'mask').mockImplementation(() => {
      throw new Error('Regex engine overflow simulation');
    });

    const msg: IncomingMessage = {
      chatId: 'test_prof_crash@s.whatsapp.net',
      senderId: 'user@s.whatsapp.net',
      senderName: 'User',
      text: 'Test pertanyaan profanity throw',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'prof-crash-1',
      mentionedIds: [],
    };

    const result = await processIncomingMessage(msg);
    expect(result).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith('test_prof_crash@s.whatsapp.net', 'Jawaban normal tanpa sensor');
  });
});
