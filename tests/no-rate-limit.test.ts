/**
 * Comprehensive Test Suite verifying:
 * 1. 20 unique messages from same user not blocked by local limiter
 * 2. 50 different messageIds all eligible to be processed
 * 3. Duplicate messageId only processed once
 * 4. Different chats processed in parallel
 * 5. Same chat processed sequentially (order preservation)
 * 6. No artificial delay before Gemini
 * 7. No RATE_LIMIT_PER_MINUTE dependency
 * 8. Gemini 429 detected as provider error with proper fallback text
 * 9. Gemini 429 max 1 fast retry
 * 10. Fallback model used if configured
 * 11. Normal Gemini request experiences no delay
 * 12. Memory/history remains valid after many messages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { memory } from '../src/services/memory';
import { idempotency } from '../src/services/idempotency';
import * as whatsappService from '../src/services/whatsapp';
import { config } from '../src/config';
import { parseGeminiError, generateReply } from '../src/services/gemini';

const { mockGenerateContent } = vi.hoisted(() => {
  return {
    mockGenerateContent: vi.fn(),
  };
});

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: mockGenerateContent,
      };
    },
  };
});

describe('No Local Rate Limiting & High Throughput Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGenerateContent.mockReset();
    memory.clearAll();
    idempotency.clear();
    (config as any).geminiFallbackModel = '';
    (config as any).aiProvider = 'gemini';
  });

  // 1. 20 pesan unik dari user yang sama tidak diblok local limiter
  it('1. 20 unique messages from the same user are NOT blocked by local limiter', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockGenerateContent.mockResolvedValue({ text: 'Jawaban AI' } as any);

    const senderId = '628111111111@s.whatsapp.net';
    const results: boolean[] = [];

    for (let i = 1; i <= 20; i++) {
      const res = await processIncomingMessage({
        messageId: `MSG_20_${i}`,
        chatId: senderId,
        senderId,
        text: `Pertanyaan ke-${i}`,
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 1000 + i,
        messageType: 'text',
      });
      results.push(res);
    }

    // All 20 messages must succeed without any rate limit blocking
    expect(results).toHaveLength(20);
    expect(results.every((r) => r === true)).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(20);
  });

  // 2. 50 messageId berbeda semuanya eligible untuk diproses
  it('2. 50 different messageIds are all eligible to be processed', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockGenerateContent.mockResolvedValue({ text: 'Jawaban AI' } as any);

    const chatId = '628222222222@s.whatsapp.net';
    const results: boolean[] = [];

    for (let i = 1; i <= 50; i++) {
      const res = await processIncomingMessage({
        messageId: `ID_50_${i}`,
        chatId,
        senderId: chatId,
        text: `Pesan unik #${i}`,
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 2000 + i,
        messageType: 'text',
      });
      results.push(res);
    }

    expect(results).toHaveLength(50);
    expect(results.every((r) => r === true)).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(50);
  });

  // 3. duplicate messageId tetap hanya diproses satu kali (Idempotency)
  it('3. duplicate messageId is only processed once (idempotency preserved)', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockGenerateContent.mockResolvedValue({ text: 'Jawaban unik' } as any);

    const chatId = '628333333333@s.whatsapp.net';
    const duplicateId = 'DUPLICATE_MSG_ID_100';

    // First attempt
    const firstRes = await processIncomingMessage({
      messageId: duplicateId,
      chatId,
      senderId: chatId,
      text: 'Pesan asli',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 3000,
      messageType: 'text',
    });

    // Second attempt (exact same messageId)
    const secondRes = await processIncomingMessage({
      messageId: duplicateId,
      chatId,
      senderId: chatId,
      text: 'Pesan asli',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 3001,
      messageType: 'text',
    });

    expect(firstRes).toBe(true);
    expect(secondRes).toBe(false); // Ignored as duplicate
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  // 4. chat berbeda diproses paralel
  it('4. different chats are processed in parallel without blocking each other', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const activeChats: string[] = [];
    let hadConcurrency = false;

    mockGenerateContent.mockImplementation((args: any) => {
      const prompt = args.contents[args.contents.length - 1].parts[0].text;
      activeChats.push(prompt);
      if (activeChats.length > 1) {
        hadConcurrency = true;
      }

      return new Promise((resolve) => {
        setTimeout(() => {
          const idx = activeChats.indexOf(prompt);
          if (idx !== -1) activeChats.splice(idx, 1);
          resolve({ text: `Reply to ${prompt}` } as any);
        }, 40);
      });
    });

    const chat1 = '628100000001@s.whatsapp.net';
    const chat2 = '628100000002@s.whatsapp.net';

    const p1 = processIncomingMessage({
      messageId: 'M_PARALLEL_1',
      chatId: chat1,
      senderId: chat1,
      text: 'Chat 1 prompt',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 4000,
      messageType: 'text',
    });

    const p2 = processIncomingMessage({
      messageId: 'M_PARALLEL_2',
      chatId: chat2,
      senderId: chat2,
      text: 'Chat 2 prompt',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 4001,
      messageType: 'text',
    });

    await Promise.all([p1, p2]);

    expect(hadConcurrency).toBe(true);
  });

  // 5. same chat diproses berurutan
  it('5. messages for the same chat are processed sequentially to protect history', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const timeline: string[] = [];
    mockGenerateContent.mockImplementation((args: any) => {
      const prompt = args.contents[args.contents.length - 1].parts[0].text;
      timeline.push(`start:${prompt}`);
      return new Promise((resolve) => {
        setTimeout(() => {
          timeline.push(`end:${prompt}`);
          resolve({ text: `Reply: ${prompt}` } as any);
        }, 20);
      });
    });

    const sameChat = '628555555555@s.whatsapp.net';

    const p1 = processIncomingMessage({
      messageId: 'SEQ_1',
      chatId: sameChat,
      senderId: sameChat,
      text: 'Order 1',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 5000,
      messageType: 'text',
    });

    const p2 = processIncomingMessage({
      messageId: 'SEQ_2',
      chatId: sameChat,
      senderId: sameChat,
      text: 'Order 2',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 5001,
      messageType: 'text',
    });

    await Promise.all([p1, p2]);

    expect(timeline).toEqual(['start:Order 1', 'end:Order 1', 'start:Order 2', 'end:Order 2']);
  });

  // 6 & 11. tidak ada artificial delay sebelum Gemini & normal Gemini request tidak mengalami delay
  it('6 & 11. normal Gemini request experiences no artificial delay or cooldown', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockGenerateContent.mockResolvedValue({ text: 'Fast reply' } as any);

    const chatId = '628666666666@s.whatsapp.net';
    const start = Date.now();

    await processIncomingMessage({
      messageId: 'FAST_1',
      chatId,
      senderId: chatId,
      text: 'Pesan cepat',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 6000,
      messageType: 'text',
    });

    const duration = Date.now() - start;
    // Must complete immediately without sleep/delay (well under 150ms)
    expect(duration).toBeLessThan(150);
  });

  // 7. tidak ada RATE_LIMIT_PER_MINUTE dependency
  it('7. config does not contain or require RATE_LIMIT_PER_MINUTE', () => {
    expect((config as any).rateLimitPerMinute).toBeUndefined();
  });

  // 8. Gemini 429 terdeteksi sebagai provider error
  it('8. Gemini 429 is recognized as provider rate limit and sends appropriate fallback', async () => {
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockGenerateContent.mockRejectedValue({
      status: 429,
      message: 'RESOURCE_EXHAUSTED: You exceeded your current quota',
    });

    const parsed = parseGeminiError({
      status: 429,
      message: 'RESOURCE_EXHAUSTED: You exceeded your current quota',
    });
    expect(parsed.isRateLimit).toBe(true);

    const chatId = '628777777777@s.whatsapp.net';
    const res = await processIncomingMessage({
      messageId: 'ERR_429',
      chatId,
      senderId: chatId,
      text: 'Pertanyaan saat 429',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 7000,
      messageType: 'text',
    });

    expect(res).toBe(false);
    expect(sendSpy).toHaveBeenCalledWith(
      chatId,
      'AI sedang ramai sebentar. Coba lagi beberapa saat ya.'
    );
  });

  // 9. Gemini 429 maksimal satu retry cepat
  it('9. Gemini 429 performs at most 1 fast retry', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    // First attempt fails 429, second attempt succeeds
    mockGenerateContent
      .mockRejectedValueOnce({ status: 429, message: 'RESOURCE_EXHAUSTED' })
      .mockResolvedValueOnce({ text: 'Jawaban setelah 1x retry cepat' } as any);

    const reply = await generateReply({
      message: 'Pertanyaan retry',
      chatId: '628888888888@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Jawaban setelah 1x retry cepat');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  // 10. fallback model digunakan jika dikonfigurasi
  it('10. fallback model is used once if configured when primary fails with 429/503', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    (config as any).geminiFallbackModel = 'gemini-1.5-flash';

    const calledModels: string[] = [];
    mockGenerateContent.mockImplementation((args: any) => {
      calledModels.push(args.model);
      if (args.model === config.geminiModel) {
        return Promise.reject({ status: 503, message: 'Primary service overloaded' });
      }
      return Promise.resolve({ text: 'Jawaban dari fallback model' } as any);
    });

    const reply = await generateReply({
      message: 'Pertanyaan fallback',
      chatId: '628999999999@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Jawaban dari fallback model');
    expect(calledModels).toContain('gemini-1.5-flash');
  });

  // 12. memory/history tetap valid setelah banyak pesan
  it('12. memory/history remains valid and strictly alternating after many messages', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    mockGenerateContent.mockImplementation((args: any) => {
      const prompt = args.contents[args.contents.length - 1].parts[0].text;
      return Promise.resolve({ text: `Jawaban untuk: ${prompt}` } as any);
    });

    const chatId = '628123456000@s.whatsapp.net';

    for (let i = 1; i <= 15; i++) {
      await processIncomingMessage({
        messageId: `BULK_${i}`,
        chatId,
        senderId: chatId,
        text: `Pertanyaan bulk ${i}`,
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 8000 + i,
        messageType: 'text',
      });
    }

    const history = memory.getHistory(chatId);
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(config.maxHistoryMessages * 2);

    // Verify alternation: user -> assistant -> user -> assistant
    for (let i = 0; i < history.length; i++) {
      if (i % 2 === 0) {
        expect(history[i].role).toBe('user');
      } else {
        expect(history[i].role).toBe('assistant');
      }
    }
  });
});
