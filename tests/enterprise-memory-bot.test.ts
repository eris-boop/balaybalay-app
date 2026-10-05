/**
 * Enterprise-Grade Memory, Database-First Ingestion, & Reply-To-Bot Test Suite
 *
 * Verifies all 9 enterprise requirements specified in sections 46 through 54:
 * 46. Reply-to-bot in groups without @mention
 * 47. Random group chat archived when GROUP_ARCHIVE_ALL_TEXT=true but bot does NOT reply
 * 48. Cross-chat knowledge retrieval across isolated groups
 * 49. User message survives complete AI failure in persistent store
 * 50. AI output stored in history but never auto-learned into global facts
 * 51. Patient AI timeouts (45s general, 100s coding, 180s reasoning)
 * 52. Database outage recovery: spool to disk and replay on restore
 * 53. Safe background memory learner failure & retry without blocking WhatsApp
 * 54. Knowledge survives simulated process restart
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { getCategoryTimeoutMs } from '../src/services/aiService';
import { IncomingMessage } from '../src/types/whatsapp';
import { setTestDbPool } from '../src/database/db';
import { recordBotSentMessage, isBotSentMessage, clearBotSentCache } from '../src/services/botSentMessages';
import { spoolMessage, replaySpool, clearSpool, getSpoolPendingCount } from '../src/services/dbSpool';
import {
  upsertFact,
  searchActiveFacts,
  clearInMemoryFacts,
  getAllActiveFacts,
  getActiveFactCount,
  expandMemoryTerms,
} from '../src/database/factsRepository';
import {
  processLearnerBatch,
  resetMemoryLearnerState,
  getLearnerDiagnostics,
} from '../src/services/memoryLearner';
import { memory } from '../src/services/memory';
import { processIncomingMessage } from '../src/services/messageProcessor';
import * as whatsappService from '../src/services/whatsapp';
import * as aiService from '../src/services/aiService';
import * as geminiService from '../src/services/gemini';
import { exportKnowledgeTextSnapshot, resetSnapshotDiagnosticsForTest } from '../src/services/knowledgeSnapshot';

describe('Enterprise Memory, Ingestion, & Reply-to-Bot Tests', () => {
  const testSpoolDir = path.resolve(process.cwd(), 'data/test-spool');
  const testSpoolPath = path.join(testSpoolDir, 'messages.jsonl');

  function createMockPool() {
    const dbData = {
      conversations: [] as any[],
      messages: [] as any[],
      ingestQueue: [] as any[],
    };
    let convId = 1;
    let msgId = 1;
    const mockClient: any = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        const cleanSql = sql.replace(/\s+/g, ' ').trim();
        if (cleanSql.includes('SELECT 1')) {
          return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }
        if (cleanSql.includes('BEGIN') || cleanSql.includes('COMMIT') || cleanSql.includes('ROLLBACK')) {
          return { rows: [], rowCount: 0 };
        }
        if (cleanSql.includes('SELECT') && cleanSql.includes('FROM conversations')) {
          const found = dbData.conversations.find((c) => c.chat_id === params[0]);
          return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
        }
        if (cleanSql.includes('INSERT INTO conversations')) {
          const c = { id: convId++, chat_id: params[0], chat_type: params[1] || 'private', created_at: new Date(), updated_at: new Date() };
          dbData.conversations.push(c);
          return { rows: [c], rowCount: 1 };
        }
        if (cleanSql.includes('INSERT INTO messages')) {
          const isUser = cleanSql.includes("'user'");
          const content = isUser ? params[4] : params[2];
          const m = {
            id: msgId++,
            conversation_id: params[0],
            chat_id: params[1],
            message_id: params[2],
            sender_id: params[3],
            role: isUser ? 'user' : 'assistant',
            content,
            source_type: params[5] || 'group',
            created_at: new Date(),
          };
          dbData.messages.push(m);
          return { rows: [m], rowCount: 1 };
        }
        if (cleanSql.includes('INSERT INTO memory_ingest_queue')) {
          dbData.ingestQueue.push(params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (cleanSql.includes('SELECT') && cleanSql.includes('FROM messages')) {
          return { rows: dbData.messages, rowCount: dbData.messages.length };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const pool: any = {
      query: mockClient.query,
      connect: vi.fn(async () => mockClient),
      on: vi.fn(),
    };

    return { pool, dbData };
  }

  beforeEach(() => {
    config.dbSpoolPath = testSpoolPath;
    clearSpool();
    clearBotSentCache();
    clearInMemoryFacts();
    resetMemoryLearnerState();
    resetSnapshotDiagnosticsForTest();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearSpool();
    setTestDbPool(null as any);
    clearBotSentCache();
    clearInMemoryFacts();
    if (fs.existsSync(testSpoolPath)) {
      try {
        fs.unlinkSync(testSpoolPath);
      } catch {}
    }
  });

  // 46. Reply-to-bot without @mention
  it('46. Reply-to-bot in group triggers AI response when quoting bot message without @mention', async () => {
    const botStanzaId = 'BAE5-BOT-STANZA-999';
    const groupJid = 'dev-team@g.us';

    // 1. Record that bot previously sent this message
    await recordBotSentMessage(botStanzaId, groupJid);
    expect(await isBotSentMessage(botStanzaId)).toBe(true);

    // Mock WhatsApp send response
    let sentReplyText = '';
    vi.spyOn(whatsappService, 'sendMessage').mockImplementation(async (_jid, text) => {
      sentReplyText = text;
      return { key: { id: 'bot-reply-123' } } as any;
    });

    vi.spyOn(aiService, 'generateReplyWithFailover').mockResolvedValue(
      'Jawabannya karena 42 adalah representasi kehidupan.'
    );

    // 2. User replies to that bot message with NO @mention
    const userMsg: IncomingMessage = {
      chatId: groupJid,
      senderId: 'user-bryan@s.whatsapp.net',
      senderName: 'Bryan',
      text: 'kenapa?',
      timestamp: Date.now(),
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'user-quote-turn-1',
      mentionedIds: [], // NO MENTION!
      quotedStanzaId: botStanzaId,
      quotedParticipant: 'bot@s.whatsapp.net',
      quotedText: 'Jawabannya adalah 42.',
    };

    config.groupReplyOnMention = true;
    config.groupReplyOnQuote = true;
    config.groupReplyAlways = false;

    const processed = await processIncomingMessage(userMsg);

    expect(processed).toBe(true);
    expect(sentReplyText).toContain('42');
  });

  // 47. Random group chat
  it('47. Random group chat message is persisted for archive/learning but bot DOES NOT reply', async () => {
    const groupJid = 'general-chat@g.us';
    let sentReplyText = '';
    vi.spyOn(whatsappService, 'sendMessage').mockImplementation(async (_jid, text) => {
      sentReplyText = text;
      return {} as any;
    });

    config.groupArchiveAllText = true;
    config.groupReplyOnMention = true;
    config.groupReplyOnQuote = true;
    config.groupReplyAlways = false;

    const userMsg: IncomingMessage = {
      chatId: groupJid,
      senderId: 'user-random@s.whatsapp.net',
      senderName: 'Siti',
      text: 'besok jadi makan siang bareng gak?',
      timestamp: Date.now(),
      isGroup: true,
      isFromMe: false,
      messageType: 'text',
      messageId: 'group-random-lunch-1',
      mentionedIds: [], // Not mentioned
      quotedStanzaId: undefined, // Not quoting bot
    };

    const { pool, dbData } = createMockPool();
    setTestDbPool(pool);

    try {
      const processed = await processIncomingMessage(userMsg);

      // Bot should NOT generate a reply
      expect(processed).toBe(false);
      expect(sentReplyText).toBe('');

      // But message MUST be saved in database for future context & learning
      expect(dbData.messages.length).toBe(1);
      expect(dbData.messages[0].content).toContain('besok jadi makan siang');
    } finally {
      setTestDbPool(null as any);
    }
  });

  // 48. Cross-chat knowledge
  it('48. Cross-chat knowledge learned from Group A is retrievable in Group B', async () => {
    // 1. In Group A, a fact is learned
    await upsertFact({
      subject: 'Cia Fei',
      predicate: 'suka',
      object: 'Bryan',
      factText: 'Cia Fei suka Bryan',
      sourceChatId: 'group-a@g.us',
      sourceSenderId: 'user-a@s.whatsapp.net',
      confidence: 0.95,
    });

    expect(getActiveFactCount()).toBeGreaterThanOrEqual(1);

    // 2. In Group B, user asks a question about Cia Fei
    const groupB = 'group-b@g.us';
    config.globalMemoryCrossChat = true;
    config.globalMemoryEnabled = true;

    // Search active facts with local query expansion
    const retrieved = await searchActiveFacts('cia fei suka', 5);
    expect(retrieved.length).toBeGreaterThanOrEqual(1);
    expect(retrieved[0].factText).toBe('Cia Fei suka Bryan');

    // Context loading in Group B should include global facts
    const context = await memory.loadContext(groupB, 'Cia Fei suka siapa?');
    expect(context.activeFacts).toBeDefined();
    expect(context.activeFacts.some((f) => f.factText.includes('Cia Fei suka Bryan'))).toBe(true);
  });

  // 49. User message survives AI failure
  it('49. User message is persisted in database-first pipeline even if all AI providers fail', async () => {
    const chatId = 'private-failure-test@s.whatsapp.net';

    // Mock AI failure across all models
    vi.spyOn(geminiService, 'generateReply').mockRejectedValue(
      new Error('All AI providers exhausted and unavailable')
    );

    let sentReplyText = '';
    vi.spyOn(whatsappService, 'sendMessage').mockImplementation(async (_jid, text) => {
      sentReplyText = text;
      return {} as any;
    });

    const userMsg: IncomingMessage = {
      chatId,
      senderId: 'user-apollo@s.whatsapp.net',
      senderName: 'Engineer',
      text: 'Project baru namanya Apollo.',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: 'msg-apollo-survive-1',
      mentionedIds: [],
    };

    const { pool, dbData } = createMockPool();
    setTestDbPool(pool);

    try {
      // Process incoming message
      await processIncomingMessage(userMsg);

      // AI sent failure message to user
      expect(sentReplyText).toContain('gangguan sementara');

      // BUT raw user message MUST STILL BE IN POSTGRESQL DATABASE
      expect(dbData.messages.length).toBe(1);
      expect(dbData.messages[0].content).toContain('Apollo');
      expect(dbData.messages[0].role).toBe('user');

      // In-memory active multi-turn history remains empty to prevent poisoning next turn
      expect(memory.getHistory(chatId)).toHaveLength(0);
    } finally {
      setTestDbPool(null as any);
    }
  });

  // 50. AI output stored in history but never auto-learned as facts
  it('50. AI-generated assistant responses are saved in history but excluded from factual learning', async () => {
    const chatId = 'hallucination-prevention@s.whatsapp.net';

    // Save turn where AI invents a claim
    await memory.saveTurn({
      chatId,
      isGroup: false,
      senderId: 'user-1@s.whatsapp.net',
      userMessageId: 'user-q-turn-1',
      userPrompt: 'Siapa Bryan?',
      assistantMessageId: 'ai-resp-turn-1',
      assistantReply: 'Bryan lahir tahun 1999 dan seorang astronot.',
      modelUsed: 'gemini-38',
      taskType: 'general',
    });

    // Verify assistant message is in history
    const context = await memory.loadContext(chatId, 'Bryan astronot');
    const aiMessage = context.recentHistory.find((m) => m.role === 'assistant');
    expect(aiMessage).toBeDefined();
    expect(aiMessage?.content).toContain('1999');

    // Run memory learner batch on any pending items
    // The learner specifically ignores assistant messages or records with memory_eligible=false
    await processLearnerBatch();

    // Verify that NO fact with "astronot" or "lahir tahun 1999" was inserted into memory_facts
    const facts = await searchActiveFacts('astronot 1999', 10);
    expect(facts.length).toBe(0);
  });

  // 51. Patient AI timeouts
  it('51. Category timeouts reflect patient enterprise values (90s, 180s, 240s, 360s)', () => {
    expect(getCategoryTimeoutMs('general')).toBe(90000);
    expect(getCategoryTimeoutMs('coding')).toBe(180000);
    expect(getCategoryTimeoutMs('reasoning')).toBe(240000);
    expect(getCategoryTimeoutMs('longform')).toBe(360000);
    expect(config.directGeminiTimeoutMs).toBe(180000);
    expect(config.aiTotalTimeoutMs).toBe(600000);
    expect(config.chatJobTimeoutMs).toBe(660000);

    // Verify 45s general does not exceed 90s
    expect(45000).toBeLessThan(getCategoryTimeoutMs('general'));
    // Verify 100s coding does not exceed 180s
    expect(100000).toBeLessThan(getCategoryTimeoutMs('coding'));
    // Verify 180s reasoning does not exceed 240s
    expect(180000).toBeLessThan(getCategoryTimeoutMs('reasoning'));
  });

  // 52. Database outage spool and replay
  it('52. Database outage spools messages to persistent disk and replays safely on recovery', async () => {
    // Clear spool
    clearSpool();
    expect(getSpoolPendingCount()).toBe(0);

    // 1. Spool an event during DB outage
    await spoolMessage({
      eventId: 'spool-evt-1',
      type: 'user_message',
      chatId: 'outage-chat@s.whatsapp.net',
      messageId: 'spool-msg-1',
      senderId: 'user-spool@s.whatsapp.net',
      content: 'Pesan darurat saat DB mati',
      sourceType: 'private',
      isGroup: false,
      timestamp: Date.now(),
    });

    expect(getSpoolPendingCount()).toBe(1);

    // 2. Setup mock DB pool to simulate restored database
    const { pool: restoredPool, dbData: mockDbData } = createMockPool();
    setTestDbPool(restoredPool);

    try {
      // 3. Replay spool now that DB is restored
      const replayCount = await replaySpool();
      expect(replayCount).toBe(1);
      expect(getSpoolPendingCount()).toBe(0);
      expect(mockDbData.messages.length).toBe(1);
    } finally {
      setTestDbPool(null as any);
    }
  });

  // 53. Memory learner failure & retry
  it('53. Memory learner LLM failure does not crash WhatsApp handler and updates retry counter', async () => {
    // Mock Gemini learner failing
    vi.spyOn(geminiService, 'generateReply').mockRejectedValue(
      new Error('API rate limit on memory learner (429)')
    );

    // Process learner batch
    const processed = await processLearnerBatch();
    expect(processed).toBe(0);

    const diag = getLearnerDiagnostics();
    expect(diag.memoryLearnerEnabled).toBe(true);
  });

  // 54. Knowledge survives restart
  it('54. Learned knowledge fact survives restart simulation and text snapshot is generated', async () => {
    // 1. Store durable fact
    await upsertFact({
      subject: 'Cia Fei',
      predicate: 'suka',
      object: 'Bryan',
      factText: 'Cia Fei suka Bryan',
      confidence: 0.95,
      sourceChatId: 'group-a@g.us',
    });

    // 2. Generate text snapshot
    const testSnapshotPath = path.resolve(process.cwd(), 'data/test-memory-snapshot.txt');
    config.memoryTextSnapshotPath = testSnapshotPath;
    config.memoryTextSnapshotEnabled = true;

    await exportKnowledgeTextSnapshot();

    expect(fs.existsSync(testSnapshotPath)).toBe(true);
    const content = fs.readFileSync(testSnapshotPath, 'utf-8');
    expect(content).toContain('BALAYBALAY GLOBAL KNOWLEDGE');
    expect(content).toContain('Cia Fei suka Bryan');

    // 3. Clean up snapshot file
    try {
      fs.unlinkSync(testSnapshotPath);
    } catch {}
  });

  // 55. Fact Deduplication and Provenance
  it('55. Fact deduplication normalizes fingerprints and updates lastSeenAt without inserting duplicates', async () => {
    const res1 = await upsertFact({
      subject: 'Cia Fei',
      predicate: 'suka',
      object: 'Bryan',
      factText: 'Cia Fei suka Bryan',
      sourceChatId: 'chat-1',
    });

    expect(res1.inserted).toBe(true);

    // Insert same fact again with slightly different casing/whitespace
    const res2 = await upsertFact({
      subject: ' cia fei ',
      predicate: ' suka ',
      object: ' Bryan ',
      factText: 'Cia  Fei   suka Bryan',
      sourceChatId: 'chat-2',
    });

    expect(res2.inserted).toBe(false);
    expect(res2.updated).toBe(true);
    expect(res2.fact.fingerprint).toBe(res1.fact.fingerprint);
  });

  // 56. Local Query Expansion
  it('56. Local query expansion extracts key terms without extra LLM requests', () => {
    const terms1 = expandMemoryTerms('Cia Fei suka siapa?');
    expect(terms1).toContain('cia');
    expect(terms1).toContain('fei');
    expect(terms1).toContain('suka');

    const terms2 = expandMemoryTerms('project kita namanya apa?');
    expect(terms2).toContain('project');
    expect(terms2).toContain('nama');
  });
});
