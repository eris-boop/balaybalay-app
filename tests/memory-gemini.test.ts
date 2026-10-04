/**
 * Regression and Unit Test Suite for Conversation Memory & Gemini History Handling.
 *
 * Verifies:
 * 1. Exactly alternating user/model turns for Gemini API
 * 2. assistant -> model role normalization
 * 3. Exact user reproduction sequence:
 *    - Hai -> Halo Michael!
 *    - Hai -> Halo lagi!
 *    - Jokowi siapa -> Success
 *    - Oke bang -> Success
 * 4. Verification that role='assistant' NEVER reaches Gemini contents
 * 5. Memory is NOT polluted when Gemini fails
 * 6. Per-chat serialization queue prevents race conditions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeGeminiHistory, generateReply } from '../src/services/gemini';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { memory } from '../src/services/memory';
import * as whatsappService from '../src/services/whatsapp';
import { config } from '../src/config';

const { mockGenerateContent } = vi.hoisted(() => {
  return {
    mockGenerateContent: vi.fn(),
  };
});

// Mock the GoogleGenAI SDK
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: mockGenerateContent,
      };
    },
  };
});

describe('Gemini Conversation History & Memory Service', () => {
  const chatId = '628999888777@s.whatsapp.net';

  beforeEach(() => {
    vi.restoreAllMocks();
    mockGenerateContent.mockReset();
    memory.clearAll();
    (config as any).aiProvider = 'gemini';
  });

  // --------------------------------------------------------------------------
  // 1. sanitizeGeminiHistory unit tests
  // --------------------------------------------------------------------------
  describe('sanitizeGeminiHistory', () => {
    it('normalizes role assistant to model', () => {
      const rawHistory = [
        { role: 'user' as const, content: 'Hai', timestamp: 1 },
        { role: 'assistant' as const, content: 'Halo Michael!', timestamp: 2 },
      ];

      const result = sanitizeGeminiHistory(rawHistory);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'Hai' }] });
      expect(result[1]).toEqual({ role: 'model', parts: [{ text: 'Halo Michael!' }] });
    });

    it('filters out invalid roles such as system, bot, ai', () => {
      const rawHistory = [
        { role: 'system' as any, content: 'You are an AI assistant', timestamp: 1 },
        { role: 'user' as const, content: 'Hai', timestamp: 2 },
        { role: 'bot' as any, content: 'Halo dari bot', timestamp: 3 },
      ];

      const result = sanitizeGeminiHistory(rawHistory);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('model');
    });

    it('removes empty or whitespace-only messages', () => {
      const rawHistory = [
        { role: 'user' as const, content: '   ', timestamp: 1 },
        { role: 'user' as const, content: 'Hai valid', timestamp: 2 },
        { role: 'assistant' as const, content: '', timestamp: 3 },
        { role: 'assistant' as const, content: 'Halo valid', timestamp: 4 },
      ];

      const result = sanitizeGeminiHistory(rawHistory);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'Hai valid' }] });
      expect(result[1]).toEqual({ role: 'model', parts: [{ text: 'Halo valid' }] });
    });

    it('merges consecutive user turns to enforce alternating sequence', () => {
      const rawHistory = [
        { role: 'user' as const, content: 'Hai pertama', timestamp: 1 },
        { role: 'user' as const, content: 'Hai kedua', timestamp: 2 },
        { role: 'assistant' as const, content: 'Halo jawaban', timestamp: 3 },
      ];

      const result = sanitizeGeminiHistory(rawHistory);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[0].parts[0].text).toBe('Hai pertama\nHai kedua');
      expect(result[1].role).toBe('model');
      expect(result[1].parts[0].text).toBe('Halo jawaban');
    });

    it('removes trailing user turns so history always ends with model', () => {
      const rawHistory = [
        { role: 'user' as const, content: 'Pesan 1', timestamp: 1 },
        { role: 'assistant' as const, content: 'Balasan 1', timestamp: 2 },
        { role: 'user' as const, content: 'Pesan tanpa balasan', timestamp: 3 },
      ];

      const result = sanitizeGeminiHistory(rawHistory);
      // Trailing user turn is removed so history ends with 'model'
      expect(result).toHaveLength(2);
      expect(result[result.length - 1].role).toBe('model');
    });

    it('removes leading model turns so history always starts with user', () => {
      const rawHistory = [
        { role: 'assistant' as const, content: 'Greeting awal', timestamp: 1 },
        { role: 'user' as const, content: 'Hai', timestamp: 2 },
        { role: 'assistant' as const, content: 'Halo', timestamp: 3 },
      ];

      const result = sanitizeGeminiHistory(rawHistory);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('model');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Exact reproduction sequence test: Hai -> Hai -> Jokowi siapa -> Oke bang
  // --------------------------------------------------------------------------
  describe('Full Conversation Sequence (Reproduction)', () => {
    it('successfully processes: Hai -> Hai -> Jokowi siapa -> Oke bang with valid alternating turns', async () => {
      vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

      const capturedCalls: any[] = [];
      mockGenerateContent.mockImplementation((args: any) => {
        capturedCalls.push(args);
        const prompt = args.contents[args.contents.length - 1].parts[0].text;
        if (prompt.includes('Jokowi siapa')) {
          return Promise.resolve({ text: 'Jokowi adalah Presiden ke-7 Republik Indonesia.' } as any);
        }
        if (prompt.includes('Oke bang')) {
          return Promise.resolve({ text: 'Sama-sama! Senang bisa membantu.' } as any);
        }
        if (capturedCalls.length === 1) {
          return Promise.resolve({ text: 'Halo Michael!' } as any);
        }
        return Promise.resolve({ text: 'Halo lagi!' } as any);
      });

      // 1. Message 1: "Hai"
      const res1 = await processIncomingMessage({
        messageId: 'MSG_1',
        chatId,
        senderId: chatId,
        text: 'Hai',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 1000,
        messageType: 'text',
      });
      expect(res1).toBe(true);

      // 2. Message 2: "Hai" (second rapid greeting)
      const res2 = await processIncomingMessage({
        messageId: 'MSG_2',
        chatId,
        senderId: chatId,
        text: 'Hai',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 2000,
        messageType: 'text',
      });
      expect(res2).toBe(true);

      // 3. Message 3: "Jokowi siapa"
      const res3 = await processIncomingMessage({
        messageId: 'MSG_3',
        chatId,
        senderId: chatId,
        text: 'Jokowi siapa',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 3000,
        messageType: 'text',
      });
      expect(res3).toBe(true);

      // 4. Message 4: "Oke bang"
      const res4 = await processIncomingMessage({
        messageId: 'MSG_4',
        chatId,
        senderId: chatId,
        text: 'Oke bang',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 4000,
        messageType: 'text',
      });
      expect(res4).toBe(true);

      // Verify all 4 calls reached Gemini
      expect(capturedCalls).toHaveLength(4);

      // Verify Call 3 ("Jokowi siapa") contents:
      const call3Contents = capturedCalls[2].contents;
      // Must NOT contain role: 'assistant'
      for (const turn of call3Contents) {
        expect(['user', 'model']).toContain(turn.role);
        expect(turn.role).not.toBe('assistant');
        expect(turn.parts[0].text.trim().length).toBeGreaterThan(0);
      }
      // Must alternate: user, model, user, model...
      for (let i = 1; i < call3Contents.length; i++) {
        expect(call3Contents[i].role).not.toBe(call3Contents[i - 1].role);
      }
      // Last turn must be the current user prompt
      expect(call3Contents[call3Contents.length - 1].role).toBe('user');
      expect(call3Contents[call3Contents.length - 1].parts[0].text).toBe('Jokowi siapa');

      // Verify Call 4 ("Oke bang") contents:
      const call4Contents = capturedCalls[3].contents;
      for (const turn of call4Contents) {
        expect(['user', 'model']).toContain(turn.role);
        expect(turn.role).not.toBe('assistant');
      }
      for (let i = 1; i < call4Contents.length; i++) {
        expect(call4Contents[i].role).not.toBe(call4Contents[i - 1].role);
      }
      expect(call4Contents[call4Contents.length - 1].role).toBe('user');
      expect(call4Contents[call4Contents.length - 1].parts[0].text).toBe('Oke bang');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Fallback / error does not pollute conversation history
  // --------------------------------------------------------------------------
  describe('Error Resilience & Clean Memory', () => {
    it('does NOT save fallback error messages to conversation history when Gemini fails', async () => {
      const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
      // First call succeeds
      mockGenerateContent.mockResolvedValueOnce({ text: 'Jawaban sukses' } as any);

      await processIncomingMessage({
        messageId: 'SUCCESS_1',
        chatId,
        senderId: chatId,
        text: 'Pesan awal',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 1000,
        messageType: 'text',
      });

      expect(memory.getHistory(chatId)).toHaveLength(2);

      // Second call fails with 503 / 429
      mockGenerateContent.mockRejectedValueOnce(new Error('503 Service Unavailable'));

      const resultFail = await processIncomingMessage({
        messageId: 'FAIL_1',
        chatId,
        senderId: chatId,
        text: 'Pesan saat error',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 2000,
        messageType: 'text',
      });

      expect(resultFail).toBe(false);
      // Fallback message sent to WhatsApp
      expect(sendSpy).toHaveBeenCalledWith(
        chatId,
        'AI sedang mengalami gangguan sementara. Coba lagi beberapa saat ya.'
      );

      // Memory must STILL have only the first 2 entries!
      // The failed message and fallback text must NEVER be in memory
      const currentHistory = memory.getHistory(chatId);
      expect(currentHistory).toHaveLength(2);
      for (const entry of currentHistory) {
        expect(entry.content).not.toContain('gangguan');
        expect(entry.content).not.toContain('Pesan saat error');
      }

      // Third call succeeds without corrupted history
      mockGenerateContent.mockResolvedValueOnce({ text: 'Jawaban pulih' } as any);

      const resultRecover = await processIncomingMessage({
        messageId: 'RECOVER_1',
        chatId,
        senderId: chatId,
        text: 'Pesan setelah pulih',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 3000,
        messageType: 'text',
      });

      expect(resultRecover).toBe(true);
      expect(memory.getHistory(chatId)).toHaveLength(4);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Per-chat Concurrency Queue
  // --------------------------------------------------------------------------
  describe('Per-chat Concurrency Queue', () => {
    it('processes messages for the same chat sequentially without race condition', async () => {
      vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
      const executionOrder: string[] = [];

      mockGenerateContent.mockImplementation((args: any) => {
        const prompt = args.contents[args.contents.length - 1].parts[0].text;
        executionOrder.push(`start:${prompt}`);
        // Simulate delay
        return new Promise((resolve) => {
          setTimeout(() => {
            executionOrder.push(`end:${prompt}`);
            resolve({ text: `Reply to ${prompt}` } as any);
          }, 30);
        });
      });

      // Send two rapid messages concurrently
      const p1 = processIncomingMessage({
        messageId: 'CONCUR_1',
        chatId,
        senderId: chatId,
        text: 'Rapid 1',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 1000,
        messageType: 'text',
      });

      const p2 = processIncomingMessage({
        messageId: 'CONCUR_2',
        chatId,
        senderId: chatId,
        text: 'Rapid 2',
        isGroup: false,
        isFromMe: false,
        mentionedIds: [],
        timestamp: 1001,
        messageType: 'text',
      });

      await Promise.all([p1, p2]);

      // Execution order must be sequential: start 1 -> end 1 -> start 2 -> end 2
      expect(executionOrder).toEqual([
        'start:Rapid 1',
        'end:Rapid 1',
        'start:Rapid 2',
        'end:Rapid 2',
      ]);
    });
  });
});
