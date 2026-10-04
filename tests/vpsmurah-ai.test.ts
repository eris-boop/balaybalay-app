/**
 * Unit Test Suite for VPSMurah AI Service Multi-Model Failover.
 *
 * Verifies all 16 required behaviors:
 * 1. gemini-38 success -> hanya 1 model dipanggil
 * 2. gemini-38 429 -> gemini-37 dipanggil
 * 3. gemini-38 503 -> gemini-37 dipanggil
 * 4. gemini-38 timeout -> gemini-37 dipanggil
 * 5. gemini-38 + gemini-37 gagal -> gemini-36 dipanggil
 * 6. semua Gemini gagal -> qwen3-flash dipanggil
 * 7. qwen3-flash gagal -> gpt-5-mini dipanggil
 * 8. model sukses menghentikan failover chain
 * 9. 401 tidak mencoba seluruh model chain
 * 10. API key tidak bocor di log
 * 11. history tetap sama ketika model berganti
 * 12. SYSTEM_PROMPT tetap digunakan
 * 13. idempotency tetap bekerja
 * 14. tidak ada local rate limit
 * 15. tidak ada artificial sleep/delay
 * 16. semua model gagal -> final fallback text
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateReply,
  setTestOpenAIClient,
  resetAIState,
  getAIDiagnostics,
  getOpenAIClient,
} from '../src/services/aiService';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { memory } from '../src/services/memory';
import { idempotency } from '../src/services/idempotency';
import * as whatsappService from '../src/services/whatsapp';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';
import OpenAI from 'openai';

describe('VPSMurah AI Service & Multi-Model Failover Suite', () => {
  let mockCreate: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    memory.clearAll();
    idempotency.clear();
    resetAIState();

    (config as any).aiProvider = 'vpsmurah';
    (config as any).aiModelChain = [
      'gemini-38',
      'gemini-37',
      'gemini-36',
      'gemini-35',
      'qwen3-flash',
      'gpt-5-mini',
      'gpt-4o-mini',
      'mistral-small',
    ];

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

  afterEach(() => {
    resetAIState();
  });

  // 1. gemini-38 success -> hanya 1 model dipanggil
  it('1. gemini-38 success -> calls only 1 model and returns reply', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Halo dari gemini-38' } }],
    });

    const reply = await generateReply({
      message: 'Halo',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Halo dari gemini-38');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-38',
      })
    );
  });

  // 2. gemini-38 429 -> gemini-37 dipanggil
  it('2. gemini-38 429 -> automatically switches to gemini-37', async () => {
    mockCreate
      .mockRejectedValueOnce({ status: 429, message: 'RESOURCE_EXHAUSTED' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Jawaban dari gemini-37' } }],
      });

    const reply = await generateReply({
      message: 'Pertanyaan',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Jawaban dari gemini-37');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-37');

    const diag = getAIDiagnostics();
    expect(diag.lastUsedModel).toBe('gemini-37');
    expect(diag.lastAIStatus).toBe('success');
  });

  // 3. gemini-38 503 -> gemini-37 dipanggil
  it('3. gemini-38 503 -> automatically switches to gemini-37', async () => {
    mockCreate
      .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Sukses gemini-37' } }],
      });

    const reply = await generateReply({
      message: 'Tes 503',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Sukses gemini-37');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-37');
  });

  // 4. gemini-38 timeout -> gemini-37 dipanggil
  it('4. gemini-38 timeout -> automatically switches to gemini-37', async () => {
    mockCreate
      .mockRejectedValueOnce({ code: 'ETIMEDOUT', message: 'Connection timeout' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Sukses setelah timeout' } }],
      });

    const reply = await generateReply({
      message: 'Tes timeout',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Sukses setelah timeout');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-37');
  });

  // 5. gemini-38 + gemini-37 gagal -> gemini-36 dipanggil
  it('5. gemini-38 + gemini-37 fail -> automatically switches to gemini-36', async () => {
    mockCreate
      .mockRejectedValueOnce({ status: 429, message: 'Rate limit' })
      .mockRejectedValueOnce({ status: 500, message: 'Server error' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Sukses dari gemini-36' } }],
      });

    const reply = await generateReply({
      message: 'Tes 3 model',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Sukses dari gemini-36');
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-37');
    expect(mockCreate.mock.calls[2][0].model).toBe('gemini-36');
  });

  // 6. semua Gemini gagal -> qwen3-flash dipanggil
  it('6. all Gemini models fail -> switches to secondary non-Gemini provider model (qwen3-flash)', async () => {
    const logSpy = vi.spyOn(logger.ai, 'warn');

    mockCreate
      .mockRejectedValueOnce({ status: 429, message: 'Gemini 38 error' })
      .mockRejectedValueOnce({ status: 503, message: 'Gemini 37 error' })
      .mockRejectedValueOnce({ status: 500, message: 'Gemini 36 error' })
      .mockRejectedValueOnce({ status: 429, message: 'Gemini 35 error' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Sukses dari Qwen 3 Flash' } }],
      });

    const reply = await generateReply({
      message: 'Tes pindah non-gemini',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Sukses dari Qwen 3 Flash');
    expect(mockCreate).toHaveBeenCalledTimes(5);
    expect(mockCreate.mock.calls[4][0].model).toBe('qwen3-flash');

    // Verify boundary log
    expect(logSpy).toHaveBeenCalledWith(
      'Gemini models unavailable, switching to secondary provider model'
    );
  });

  // 7. qwen3-flash gagal -> gpt-5-mini dipanggil
  it('7. qwen3-flash fails -> switches to gpt-5-mini', async () => {
    mockCreate
      .mockRejectedValueOnce({ status: 429, message: '38' })
      .mockRejectedValueOnce({ status: 429, message: '37' })
      .mockRejectedValueOnce({ status: 429, message: '36' })
      .mockRejectedValueOnce({ status: 429, message: '35' })
      .mockRejectedValueOnce({ status: 500, message: 'Qwen failed' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Sukses dari GPT-5 mini' } }],
      });

    const reply = await generateReply({
      message: 'Tes ke gpt-5-mini',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Sukses dari GPT-5 mini');
    expect(mockCreate).toHaveBeenCalledTimes(6);
    expect(mockCreate.mock.calls[5][0].model).toBe('gpt-5-mini');
  });

  // 8. model sukses menghentikan failover chain
  it('8. successful model immediately stops the failover chain', async () => {
    mockCreate
      .mockRejectedValueOnce({ status: 429, message: 'Fail 1' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Stop disini' } }],
      });

    await generateReply({
      message: 'Cek stop',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    // Only 2 calls made, remaining 6 models never attempted
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // 9. 401 tidak mencoba seluruh model chain
  it('9. 401 unauthorized does NOT attempt the rest of the model chain', async () => {
    mockCreate.mockRejectedValueOnce({
      status: 401,
      message: 'Invalid API Key',
    });

    await expect(
      generateReply({
        message: 'Tes 401',
        chatId: 'chat-1@s.whatsapp.net',
        history: [],
      })
    ).rejects.toMatchObject({ status: 401 });

    // Stopped on first failure
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(getAIDiagnostics().lastAIStatus).toBe('failed');
  });

  // 10. API key tidak bocor di log
  it('10. API key / Bearer token is redacted in logs', async () => {
    const logWarnSpy = vi.spyOn(logger.ai, 'warn');

    mockCreate
      .mockRejectedValueOnce({
        status: 429,
        message: 'Bearer vpsmurah-super-secret-key-12345 rate limit',
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'OK' } }],
      });

    await generateReply({
      message: 'Tes log',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    for (const call of logWarnSpy.mock.calls) {
      const logText = call.join(' ');
      expect(logText).not.toContain('vpsmurah-super-secret-key-12345');
    }
  });

  // 11. history tetap sama ketika model berganti
  it('11. conversation history remains identical when failover occurs', async () => {
    const rawHistory = [
      { role: 'user' as const, content: 'Pesan user 1', timestamp: 1 },
      { role: 'assistant' as const, content: 'Balasan bot 1', timestamp: 2 },
    ];

    mockCreate
      .mockRejectedValueOnce({ status: 429, message: '38 down' })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Sukses 37' } }],
      });

    await generateReply({
      message: 'Pertanyaan baru',
      chatId: 'chat-1@s.whatsapp.net',
      history: rawHistory,
    });

    // Both calls must receive the exact same messages payload
    const firstCallMessages = mockCreate.mock.calls[0][0].messages;
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;

    expect(firstCallMessages).toEqual(secondCallMessages);
    expect(secondCallMessages).toContainEqual({
      role: 'user',
      content: 'Pesan user 1',
    });
    expect(secondCallMessages).toContainEqual({
      role: 'assistant',
      content: 'Balasan bot 1',
    });
    expect(secondCallMessages[secondCallMessages.length - 1]).toEqual({
      role: 'user',
      content: 'Pertanyaan baru',
    });
  });

  // 12. SYSTEM_PROMPT tetap digunakan
  it('12. SYSTEM_PROMPT is prepended to messages for all models', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'OK' } }],
    });

    await generateReply({
      message: 'Halo',
      chatId: 'chat-1@s.whatsapp.net',
      history: [],
    });

    const messages = mockCreate.mock.calls[0][0].messages;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(config.systemPrompt);
  });

  // 13. idempotency tetap bekerja
  it('13. idempotency prevents duplicate processing across incoming messages', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Jawaban tunggal' } }],
    });

    const res1 = await processIncomingMessage({
      messageId: 'IDEMP_MSG_1',
      chatId: 'user-1@s.whatsapp.net',
      senderId: 'user-1@s.whatsapp.net',
      text: 'Halo',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 1000,
      messageType: 'text',
    });

    const res2 = await processIncomingMessage({
      messageId: 'IDEMP_MSG_1',
      chatId: 'user-1@s.whatsapp.net',
      senderId: 'user-1@s.whatsapp.net',
      text: 'Halo',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 1001,
      messageType: 'text',
    });

    expect(res1).toBe(true);
    expect(res2).toBe(false); // Ignored duplicate
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // 14. tidak ada local rate limit
  it('14. no local rate limiter blocks multiple rapid unique messages', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Jawaban' } }],
    });

    for (let i = 1; i <= 20; i++) {
      const res = await processIncomingMessage({
        messageId: `UNIQUE_${i}`,
        chatId: 'rapid-user@s.whatsapp.net',
        senderId: 'rapid-user@s.whatsapp.net',
        text: `Pertanyaan ke-${i}`,
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 2000 + i,
        messageType: 'text',
      });
      expect(res).toBe(true);
    }

    expect(mockCreate).toHaveBeenCalledTimes(20);
  });

  // 15. tidak ada artificial sleep/delay
  it('15. normal response executes immediately with no artificial delay', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Cepat' } }],
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

  // 16. semua model gagal -> final fallback text
  it('16. all models fail -> sends exact fallback text to user', async () => {
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    // Mock all 8 models to fail with 503
    mockCreate.mockRejectedValue({ status: 503, message: 'Overloaded' });

    const chatId = 'user-fail@s.whatsapp.net';
    const result = await processIncomingMessage({
      messageId: 'MSG_ALL_FAIL',
      chatId,
      senderId: chatId,
      text: 'Pertanyaan saat semua down',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 3000,
      messageType: 'text',
    });

    expect(result).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(8);
    expect(sendSpy).toHaveBeenCalledWith(
      chatId,
      'AI sedang mengalami gangguan sementara. Coba lagi beberapa saat ya.'
    );
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

