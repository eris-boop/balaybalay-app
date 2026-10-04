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
} from '../src/services/aiService';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { memory } from '../src/services/memory';
import { idempotency } from '../src/services/idempotency';
import * as whatsappService from '../src/services/whatsapp';
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
      'gemini-37',
      'gemini-36',
      'qwen3-flash',
      'gpt-5-mini',
      'gpt-4o-mini',
      'mistral-small',
    ];
    (config as any).aiCodingChain = [
      'gemini-38',
      'gpt-53-codex',
      'qwen3-coder',
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
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
  });

  // 7. coding fallback ke gpt-53-codex
  it('7. coding task falls back to gpt-53-codex when gemini-38 fails', async () => {
    // gemini-38 fails with 429
    mockCreate.mockRejectedValueOnce({ status: 429, message: 'Rate limit' });
    // gpt-53-codex succeeds
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
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('gpt-53-codex');

    const diag = getAIDiagnostics();
    expect(diag.lastTaskType).toBe('coding');
    expect(diag.lastUsedModel).toBe('gpt-53-codex');
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
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-37');
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
      choices: [{ message: { content: 'Cepat dari gemini-37' } }],
    });

    const reply = await generateReply({
      message: 'Pertanyaan timeout',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Cepat dari gemini-37');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-37');
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
});
