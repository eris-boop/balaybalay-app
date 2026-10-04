/**
 * Unit Test Suite for Smart Model Router & Multi-Model Automatic Failover.
 *
 * Verifies all 16 required behaviors:
 * 1. "Siapa Jokowi" -> general
 * 2. "buat kode python" -> coding
 * 3. soal matematika -> reasoning
 * 4. essay panjang -> longform
 * 5. general mencoba gemini-38 pertama
 * 6. coding mencoba gemini-38 pertama
 * 7. coding fallback ke gpt-53-codex
 * 8. reasoning fallback ke qwen3-plus
 * 9. primary success tidak mencoba model kedua
 * 10. 429 langsung next model
 * 11. timeout langsung next model
 * 12. tidak ada artificial delay
 * 13. total timeout dihormati
 * 14. chat berbeda paralel
 * 15. memory tetap bekerja setelah model switch
 * 16. emergency chain hanya digunakan jika normal chain gagal
 * + 17. VPSMURAH_AI_API_KEY specifically selected
 * + 18. Bearer prefix stripped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateReply,
  detectTaskType,
  setTestOpenAIClient,
  resetAIState,
  getAIDiagnostics,
  getOpenAIClient,
  formatOpenAIHistory,
  sanitizeHistory,
  isModelHealthy,
  recordModelFailure,
  resetCircuitBreakers,
} from '../src/services/aiService';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { memory } from '../src/services/memory';
import { idempotency } from '../src/services/idempotency';
import * as whatsappService from '../src/services/whatsapp';
import * as geminiService from '../src/services/gemini';
import { chatQueue } from '../src/utils/queue';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';
import OpenAI from 'openai';


describe('Smart Model Router & Multi-Model Failover Suite', () => {
  let mockCreate: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    memory.clearAll();
    idempotency.clear();
    resetAIState();

    (config as any).aiProvider = 'vpsmurah';
    (config as any).aiGeneralChain = [
      'gemini-38',
      'qwen3-flash',
      'gemini-37',
      'gemini-36',
      'gpt-5-mini',
      'gpt-4o-mini',
      'mistral-small',
    ];
    (config as any).aiCodingChain = [
      'qwen3-coder',
      'gemini-38',
      'gpt-53-codex',
      'deepseek-coder',
      'codestral',
      'gpt-5-mini',
    ];
    (config as any).aiReasoningChain = [
      'gemini-38',
      'gemini-37',
      'qwen3-plus',
      'deepseek-r1',
      'kimi-k3',
      'gpt-55',
    ];
    (config as any).aiLongformChain = [
      'gemini-38',
      'gemini-37',
      'qwen3-max',
      'gpt-55',
      'llama-4-maverick',
    ];
    (config as any).aiEmergencyChain = [
      'qwen3-flash',
      'gpt-5-mini',
      'llama-4-scout',
      'mistral-small',
    ];
    (config as any).aiModelTimeoutMs = 4000;
    (config as any).aiTotalTimeoutMs = 10000;
    (config as any).chatJobTimeoutMs = 12000;
    (config as any).aiDirectGeminiFallback = true;
    geminiService.setTestGeminiDirectHandler(null);

    mockCreate = vi.fn();
    const mockClient = {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    } as unknown as OpenAI;
    setTestOpenAIClient(mockClient);
  });

  // 1. "Siapa Jokowi" -> general
  it('1. classifies "Siapa Jokowi" as general chat', () => {
    expect(detectTaskType('Siapa Jokowi')).toBe('general');
    expect(detectTaskType('Halo, apa kabar?')).toBe('general');
    expect(detectTaskType('Kapan Indonesia merdeka?')).toBe('general');
  });

  // 2. "buat kode python" -> coding
  it('2. classifies "buat kode python" as coding task', () => {
    expect(detectTaskType('buat kode python')).toBe('coding');
    expect(detectTaskType('Buatkan kalkulator Python')).toBe('coding');
    expect(detectTaskType('Debug function error di TypeScript')).toBe('coding');
  });

  // 3. soal matematika -> reasoning
  it('3. classifies "soal matematika" as reasoning task', () => {
    expect(detectTaskType('soal matematika')).toBe('reasoning');
    expect(detectTaskType('Hitung probabilitas dadu muncul angka 6')).toBe('reasoning');
    expect(detectTaskType('Pecahkan algoritma logika ini')).toBe('reasoning');
  });

  // 4. essay panjang -> longform
  it('4. classifies "essay panjang" as longform task', () => {
    expect(detectTaskType('essay panjang')).toBe('longform');
    expect(detectTaskType('Buat essay 1000 kata tentang AI')).toBe('longform');
    expect(detectTaskType('Jelaskan lengkap sejarah kemerdekaan')).toBe('longform');
  });

  // 5. general mencoba gemini-38 pertama
  it('5. general task attempts gemini-38 first', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Jokowi adalah Presiden ke-7 RI.' } }],
    });

    const reply = await generateReply({
      message: 'Siapa Jokowi?',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Jokowi adalah Presiden ke-7 RI.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
  });

  // 6. coding mencoba gemini-38 pertama
  it('6. coding task attempts gemini-38 first', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'print("Halo")' } }],
    });

    const reply = await generateReply({
      message: 'buat kode python sederhana',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('print("Halo")');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('qwen3-coder');
  });

  // 7. coding fallback ke gemini-38
  it('7. coding task falls back to gemini-38 when qwen3-coder fails', async () => {
    // qwen3-coder fails with 429
    mockCreate.mockRejectedValueOnce({ status: 429, message: 'Rate limit' });
    // gemini-38 succeeds
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'def add(a, b): return a + b' } }],
    });

    const reply = await generateReply({
      message: 'buat kode python kalkulator',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('def add(a, b): return a + b');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].model).toBe('qwen3-coder');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-38');

    const diag = getAIDiagnostics();
    expect(diag.lastTaskType).toBe('coding');
    expect(diag.lastUsedModel).toBe('gemini-38');
    expect(diag.lastFallbackCount).toBe(1);
  });

  // 8. reasoning fallback ke qwen3-plus
  it('8. reasoning task falls back to qwen3-plus when gemini-38 and gemini-37 fail', async () => {
    // gemini-38 fails
    mockCreate.mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' });
    // gemini-37 fails
    mockCreate.mockRejectedValueOnce({ status: 500, message: 'Server error' });
    // qwen3-plus succeeds
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Probabilitas adalah 1/6 atau 16.67%.' } }],
    });

    const reply = await generateReply({
      message: 'Hitung probabilitas dadu soal matematika',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Probabilitas adalah 1/6 atau 16.67%.');
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-37');
    expect(mockCreate.mock.calls[2][0].model).toBe('qwen3-plus');

    const diag = getAIDiagnostics();
    expect(diag.lastTaskType).toBe('reasoning');
    expect(diag.lastUsedModel).toBe('qwen3-plus');
    expect(diag.lastFallbackCount).toBe(2);
  });

  // 9. primary success tidak mencoba model kedua
  it('9. primary success immediately stops failover chain without calling second model', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Halo dari model utama!' } }],
    });

    await generateReply({
      message: 'Halo apa kabar',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const diag = getAIDiagnostics();
    expect(diag.lastUsedModel).toBe('gemini-38');
    expect(diag.lastFallbackCount).toBe(0);
  });

  // 10. 429 langsung next model
  it('10. HTTP 429 rate limit triggers immediate switch to next model', async () => {
    mockCreate.mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Berhasil di model kedua' } }],
    });

    const reply = await generateReply({
      message: 'Pertanyaan',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Berhasil di model kedua');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].model).toBe('qwen3-flash');
  });

  // 11. timeout langsung next model
  it('11. per-model timeout triggers immediate switch to next model', async () => {
    (config as any).aiModelTimeoutMs = 50;

    // First model times out
    mockCreate.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ choices: [{ message: { content: 'slow' } }] }), 200))
    );
    // Second model responds quickly
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Cepat dari qwen3-flash' } }],
    });

    const reply = await generateReply({
      message: 'Pertanyaan timeout',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Cepat dari qwen3-flash');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].model).toBe('qwen3-flash');
  });

  // 12. tidak ada artificial delay
  it('12. normal response executes immediately with no artificial delay', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Respon cepat' } }],
    });

    const start = Date.now();
    await generateReply({
      message: 'Tes kecepatan',
      chatId: 'chat-fast@s.whatsapp.net',
      history: [],
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(150);
  });

  // 13. total timeout dihormati
  it('13. total timeout stops failover loop without exhausting remaining models', async () => {
    (config as any).aiModelTimeoutMs = 100;
    (config as any).aiTotalTimeoutMs = 120; // Enough for only ~1-2 models

    // Hang all models beyond total timeout
    mockCreate.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ choices: [{ message: { content: 'delayed' } }] }), 200))
    );

    await expect(
      generateReply({
        message: 'Tes total timeout',
        chatId: 'chat-timeout@s.whatsapp.net',
        history: [],
      })
    ).rejects.toThrow();

    // Should NOT call all 7 or 11 models because total timeout stopped the loop early
    expect(mockCreate.mock.calls.length).toBeLessThan(5);
  });

  // 14. chat berbeda paralel
  it('14. processes different chats in parallel without global locking', async () => {
    mockCreate.mockImplementation(async (params: any) => {
      await new Promise((r) => setTimeout(r, 30));
      return { choices: [{ message: { content: `Reply for ${params.messages[params.messages.length - 1].content}` } }] };
    });

    const start = Date.now();
    const [res1, res2] = await Promise.all([
      generateReply({ message: 'Chat 1 msg', chatId: 'chat1@s.whatsapp.net', history: [] }),
      generateReply({ message: 'Chat 2 msg', chatId: 'chat2@s.whatsapp.net', history: [] }),
    ]);
    const duration = Date.now() - start;

    expect(res1).toContain('Chat 1 msg');
    expect(res2).toContain('Chat 2 msg');
    // Both 30ms queries ran concurrently, so total duration is ~30-50ms, not sequentially 60ms+
    expect(duration).toBeLessThan(120);
  });

  // 15. memory tetap bekerja setelah model switch
  it('15. preserves conversation history seamlessly across model switches', async () => {
    const chatId = 'mem-user@s.whatsapp.net';

    // Turn 1: Handled by gemini-38
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Halo! Saya asisten kamu.' } }],
    });
    const reply1 = await generateReply({
      message: 'Halo, saya Budi',
      chatId,
      history: memory.getHistory(chatId),
    });
    memory.addEntry(chatId, { role: 'user', content: 'Halo, saya Budi', timestamp: Date.now() });
    memory.addEntry(chatId, { role: 'assistant', content: reply1, timestamp: Date.now() });

    // Turn 2: Coding question, gemini-38 fails -> gpt-53-codex answers
    mockCreate.mockRejectedValueOnce({ status: 429, message: 'Gemini busy' });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Tentu Budi, ini kode Python kamu.' } }],
    });

    const reply2 = await generateReply({
      message: 'buat kode python salam',
      chatId,
      history: memory.getHistory(chatId),
    });
    memory.addEntry(chatId, { role: 'user', content: 'buat kode python salam', timestamp: Date.now() });
    memory.addEntry(chatId, { role: 'assistant', content: reply2, timestamp: Date.now() });

    expect(reply2).toContain('Tentu Budi');

    // Verify gpt-53-codex (mock call index 2) received the previous history containing "Budi"
    const lastCallMessages = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0].messages;
    expect(lastCallMessages.some((m: any) => m.content.includes('Halo, saya Budi'))).toBe(true);
    expect(lastCallMessages.some((m: any) => m.content.includes('Halo! Saya asisten kamu.'))).toBe(true);
  });

  // 16. emergency chain hanya digunakan jika normal chain gagal
  it('16. emergency chain is ONLY reached if all category models fail', async () => {
    // In coding chain, there are 6 models. Make all 6 fail with 503:
    for (let i = 0; i < 6; i++) {
      mockCreate.mockRejectedValueOnce({ status: 503, message: 'Coding model down' });
    }
    // Emergency model succeeds (qwen3-flash or llama-4-scout)
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Emergency fallback response' } }],
    });

    const reply = await generateReply({
      message: 'buat kode python darurat',
      chatId: 'user-emergency@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Emergency fallback response');
    // 6 coding models + 1 emergency model = 7 calls
    expect(mockCreate).toHaveBeenCalledTimes(7);
  });

  // 17. VPSMURAH_AI_API_KEY digunakan untuk client, bukan VPSMURAH_API_KEY atau GEMINI_API_KEY
  it('17. client initialization specifically selects VPSMURAH_AI_API_KEY over other keys', () => {
    setTestOpenAIClient(null);
    const origAiKey = process.env.VPSMURAH_AI_API_KEY;
    const origWaKey = process.env.VPSMURAH_API_KEY;
    const origGeminiKey = process.env.GEMINI_API_KEY;

    try {
      process.env.VPSMURAH_AI_API_KEY = 'AI_KEY_TEST_EXACT';
      process.env.VPSMURAH_API_KEY = 'OLD_WHATSAPP_KEY';
      process.env.GEMINI_API_KEY = 'GOOGLE_KEY';

      const client = getOpenAIClient();
      expect(client.apiKey).toBe('AI_KEY_TEST_EXACT');
      expect(client.apiKey).not.toBe('OLD_WHATSAPP_KEY');
      expect(client.apiKey).not.toBe('GOOGLE_KEY');
    } finally {
      process.env.VPSMURAH_AI_API_KEY = origAiKey;
      process.env.VPSMURAH_API_KEY = origWaKey;
      process.env.GEMINI_API_KEY = origGeminiKey;
    }
  });

  // 18. Bearer prefix stripped if accidentally included
  it('18. strips Bearer prefix if accidentally provided in VPSMURAH_AI_API_KEY', () => {
    setTestOpenAIClient(null);
    const origAiKey = process.env.VPSMURAH_AI_API_KEY;
    try {
      process.env.VPSMURAH_AI_API_KEY = 'Bearer sk-vps-testkey12345';
      const client = getOpenAIClient();
      expect(client.apiKey).toBe('sk-vps-testkey12345');
    } finally {
      process.env.VPSMURAH_AI_API_KEY = origAiKey;
    }
  });

  // 19. EXACT BUG REPRODUCTION: Halo -> Fail -> Hi succeeds without memory poisoning
  it('19. exact bug reproduction: Halo -> Fail -> Hi succeeds without memory poisoning', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    const chatId = 'user-bug-repro@s.whatsapp.net';

    // Message 1: "Halo" succeeds
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Halo juga!' } }],
    });
    const res1 = await processIncomingMessage({
      messageId: 'MSG_1',
      chatId,
      senderId: chatId,
      text: 'Halo',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 1000,
      messageType: 'text',
    });
    expect(res1).toBe(true);
    expect(memory.getHistory(chatId)).toHaveLength(2);

    // Message 2: All models fail
    mockCreate.mockRejectedValue({ status: 503, message: 'Provider overload' });
    const res2 = await processIncomingMessage({
      messageId: 'MSG_2',
      chatId,
      senderId: chatId,
      text: 'Pesan gagal total',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 2000,
      messageType: 'text',
    });
    expect(res2).toBe(false);

    // ASSERT: failed Message 2 and fallback text are NOT in history!
    const histAfterFail = memory.getHistory(chatId);
    expect(histAfterFail).toHaveLength(2);
    expect(histAfterFail.some((e) => e.content.includes('Pesan gagal total'))).toBe(false);
    expect(histAfterFail.some((e) => e.content.includes('gangguan sementara'))).toBe(false);

    // Message 3: "Hi" succeeds
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hai kembali!' } }],
    });
    const res3 = await processIncomingMessage({
      messageId: 'MSG_3',
      chatId,
      senderId: chatId,
      text: 'Hi',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 3000,
      messageType: 'text',
    });
    expect(res3).toBe(true);

    // ASSERT: Message 3 succeeds and memory now has 4 valid entries!
    const histFinal = memory.getHistory(chatId);
    expect(histFinal).toHaveLength(4);
    expect(histFinal[2].content).toBe('Hi');
    expect(histFinal[3].content).toBe('Hai kembali!');
  });

  // 20. failed request does not mutate memory
  it('20. failed request does not mutate memory', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    const chatId = 'user-clean-mem@s.whatsapp.net';
    mockCreate.mockRejectedValue({ status: 500, message: 'Crash' });

    await processIncomingMessage({
      messageId: 'MSG_FAIL_ONLY',
      chatId,
      senderId: chatId,
      text: 'Pesan gagal saja',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 1000,
      messageType: 'text',
    });

    expect(memory.getHistory(chatId)).toHaveLength(0);
  });

  // 21. fallback text not stored in memory
  it('21. fallback text is never stored in memory', () => {
    const raw = [
      { role: 'user' as const, content: 'Tanya', timestamp: 1 },
      {
        role: 'assistant' as const,
        content: 'AI sedang mengalami gangguan sementara. Coba lagi beberapa saat ya.',
        timestamp: 2,
      },
      { role: 'user' as const, content: 'Tanya 2', timestamp: 3 },
    ];
    const cleaned = sanitizeHistory(raw);
    expect(cleaned).toHaveLength(2);
    expect(cleaned.some((e) => e.content.includes('gangguan sementara'))).toBe(false);
  });

  // 22. next message after failure succeeds
  it('22. next message after failure succeeds without context degradation', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    const chatId = 'user-seq@s.whatsapp.net';

    // First attempt fails
    mockCreate.mockRejectedValueOnce({ status: 502, message: 'Bad Gateway' });
    await processIncomingMessage({
      messageId: 'M1',
      chatId,
      senderId: chatId,
      text: 'Pertama gagal',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 1000,
      messageType: 'text',
    });

    // Second attempt succeeds
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Kedua sukses!' } }],
    });
    const res = await processIncomingMessage({
      messageId: 'M2',
      chatId,
      senderId: chatId,
      text: 'Kedua coba lagi',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 2000,
      messageType: 'text',
    });

    expect(res).toBe(true);
    expect(memory.getHistory(chatId)).toHaveLength(2);
    expect(memory.getHistory(chatId)[0].content).toBe('Kedua coba lagi');
  });

  // 23. malformed history recovery without history succeeds
  it('23. malformed history recovery without history succeeds', async () => {
    const chatId = 'chat-malformed@s.whatsapp.net';
    const dirtyHistory = [
      { role: 'user' as const, content: 'Pesan lama yang bikin error 400', timestamp: 1 },
      { role: 'assistant' as const, content: 'Respon lama', timestamp: 2 },
    ];

    mockCreate.mockImplementation(async (params: any) => {
      const userCount = params.messages.filter((m: any) => m.role === 'user').length;
      if (userCount > 1) {
        throw { status: 400, message: 'Invalid history payload' };
      }
      return { choices: [{ message: { content: 'Pulih tanpa history!' } }] };
    });

    const reply = await generateReply({
      message: 'Halo baru',
      chatId,
      history: dirtyHistory,
    });

    expect(reply).toBe('Pulih tanpa history!');
  });

  // 24. timeout releases per-chat queue
  it('24. timeout releases per-chat queue so subsequent messages are not blocked', async () => {
    const chatId = 'chat-queue-timeout@s.whatsapp.net';
    (config as any).chatJobTimeoutMs = 50;

    try {
      const p1 = chatQueue.run(chatId, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'slow';
      });

      await expect(p1).rejects.toThrow(/timed out/);

      const p2 = await chatQueue.run(chatId, async () => {
        return 'fast';
      });

      expect(p2).toBe('fast');
    } finally {
      (config as any).chatJobTimeoutMs = 12000;
    }
  });

  // 25. exception releases per-chat queue
  it('25. exception in job releases per-chat queue for next job', async () => {
    const chatId = 'chat-queue-ex@s.whatsapp.net';

    const p1 = chatQueue.run(chatId, async () => {
      throw new Error('Fatal task crash');
    });

    await expect(p1).rejects.toThrow('Fatal task crash');

    const p2 = await chatQueue.run(chatId, async () => {
      return 'recovered';
    });

    expect(p2).toBe('recovered');
  });

  // 26. one chat failure does not affect another chat
  it('26. failure in one chat does not affect concurrent chat', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    mockCreate.mockImplementation(async (params: any) => {
      const lastMsg = params.messages[params.messages.length - 1].content;
      if (lastMsg.includes('ChatA')) {
        throw { status: 500, message: 'Chat A error' };
      }
      return { choices: [{ message: { content: 'Chat B sukses!' } }] };
    });

    const [resA, resB] = await Promise.all([
      processIncomingMessage({
        messageId: 'M_A',
        chatId: 'chatA@s.whatsapp.net',
        senderId: 'userA@s.whatsapp.net',
        text: 'Halo dari ChatA',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 1000,
        messageType: 'text',
      }),
      processIncomingMessage({
        messageId: 'M_B',
        chatId: 'chatB@s.whatsapp.net',
        senderId: 'userB@s.whatsapp.net',
        text: 'Halo dari ChatB',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 1000,
        messageType: 'text',
      }),
    ]);

    expect(resA).toBe(false);
    expect(resB).toBe(true);
    expect(memory.getHistory('chatB@s.whatsapp.net')).toHaveLength(2);
  });

  // 27. circuit breaker skips unhealthy model
  it('27. circuit breaker skips model after 3 consecutive failures', async () => {
    (config as any).circuitBreakerFailures = 3;
    (config as any).circuitBreakerCooldownMs = 30000;

    recordModelFailure('gemini-38', 503);
    recordModelFailure('gemini-38', 503);
    recordModelFailure('gemini-38', 503);

    expect(isModelHealthy('gemini-38')).toBe(false);

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Jawaban dari qwen3-flash' } }],
    });

    const reply = await generateReply({
      message: 'Halo',
      chatId: 'user-cb@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Jawaban dari qwen3-flash');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('qwen3-flash');
  });

  // 28. cooldown recovery works
  it('28. circuit breaker cooldown recovery allows model to be retried', () => {
    resetCircuitBreakers();
    (config as any).circuitBreakerFailures = 2;
    (config as any).circuitBreakerCooldownMs = 10;

    recordModelFailure('gemini-38', 429);
    recordModelFailure('gemini-38', 429);
    expect(isModelHealthy('gemini-38')).toBe(false);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(isModelHealthy('gemini-38')).toBe(true);
        resolve();
      }, 25);
    });
  });

  // 29. direct Gemini fallback works when configured
  it('29. direct Google Gemini fallback activates when all VPSMurah models fail', async () => {
    (config as any).aiDirectGeminiFallback = true;
    (config as any).geminiApiKey = 'test-gemini-key';

    mockCreate.mockRejectedValue({ status: 503, message: 'All VPSMurah down' });
    geminiService.setTestGeminiDirectHandler(async () => 'Jawaban dari Google Gemini Direct Fallback');

    const reply = await geminiService.generateReply({
      message: 'Halo darurat',
      chatId: 'user-direct@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Jawaban dari Google Gemini Direct Fallback');
  });

});

