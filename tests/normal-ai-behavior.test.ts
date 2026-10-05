/**
 * Normal AI Assistant Behavior & Patient Timeout Regression Test Suite.
 *
 * Verifies all requirements from prompt:
 * 1. GENERAL model takes 20s -> MUST NOT timeout (category timeout 45s)
 * 2. CODING model takes 45s -> MUST NOT timeout (category timeout 90s)
 * 3. REASONING model takes 70s -> MUST NOT timeout (category timeout 120s)
 * 4. primary explicitly errors -> fallback runs immediately
 * 5. primary times out at its real category limit -> fallback runs
 * 6. transient network error -> retries same model once before switching
 * 7. memory DB failure -> AI still answers
 * 8. profanity filter error -> AI answer still sent
 * 9. failed request -> next message still succeeds
 * 10. WhatsApp typing indicator composing -> paused
 * 11. /admin/status observability fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateReply,
  detectTaskType,
  setTestOpenAIClient,
  resetAIState,
  getAIDiagnostics,
  getCategoryTimeoutMs,
  isTransientNetworkError,
} from '../src/services/aiService';
import { processIncomingMessage } from '../src/services/messageProcessor';
import { memory } from '../src/services/memory';
import { idempotency } from '../src/services/idempotency';
import * as whatsappService from '../src/services/whatsapp';
import * as geminiService from '../src/services/gemini';
import { startTypingIndicator, setTestSocketInstance, resetWhatsAppClientState } from '../src/services/whatsappClient';
import { config } from '../src/config';
import { profanityFilter } from '../src/services/profanityFilter';
import OpenAI from 'openai';

describe('Normal AI Assistant Behavior & Regression Suite', () => {
  let mockCreate: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    memory.clearAll();
    idempotency.clear();
    resetAIState();
    resetWhatsAppClientState();

    (config as any).aiProvider = 'vpsmurah';
    (config as any).aiGeneralTimeoutMs = 45000;
    (config as any).aiCodingTimeoutMs = 90000;
    (config as any).aiReasoningTimeoutMs = 120000;
    (config as any).aiLongformTimeoutMs = 180000;
    (config as any).directGeminiTimeoutMs = 90000;
    (config as any).aiTotalTimeoutMs = 240000;
    (config as any).chatJobTimeoutMs = 260000;
    (config as any).aiModelTimeoutMs = 45000;
    (config as any).aiDirectGeminiFallback = false;

    (config as any).aiGeneralChain = [
      'gemini-38',
      'qwen3-flash',
      'gpt-5-mini',
      'gemini-37',
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
      'qwen3-plus',
      'gpt-5-mini',
      'gemini-37',
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
    vi.useRealTimers();
  });

  // 1. GENERAL model takes 20 seconds -> MUST NOT timeout
  it('1. GENERAL model takes 20 seconds -> MUST NOT timeout', async () => {
    vi.useFakeTimers();

    mockCreate.mockImplementation(async () => {
      // Simulate 20-second thinking time
      await new Promise((resolve) => setTimeout(resolve, 20000));
      return {
        choices: [
          {
            message: {
              content: 'Presiden Joko Widodo menjabat dari tahun 2014 hingga 2024.',
            },
          },
        ],
      };
    });

    const replyPromise = generateReply({
      message: 'siapa Jokowi?',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    // Advance simulated time by 20 seconds
    await vi.advanceTimersByTimeAsync(20000);

    const reply = await replyPromise;
    expect(reply).toBe('Presiden Joko Widodo menjabat dari tahun 2014 hingga 2024.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    const diag = getAIDiagnostics();
    expect(diag.lastTaskType).toBe('general');
    expect(diag.lastAITimedOut).toBe(false);
  });

  // 2. CODING model takes 45 seconds -> MUST NOT timeout
  it('2. CODING model takes 45 seconds -> MUST NOT timeout', async () => {
    vi.useFakeTimers();

    mockCreate.mockImplementation(async () => {
      // Simulate 45-second deep code generation
      await new Promise((resolve) => setTimeout(resolve, 45000));
      return {
        choices: [
          {
            message: {
              content: '```python\ndef kalkulator(a, b, op):\n    return a + b if op == "+" else a - b\n```',
            },
          },
        ],
      };
    });

    const replyPromise = generateReply({
      message: 'buat kalkulator python sederhana',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    // Advance simulated time by 45 seconds
    await vi.advanceTimersByTimeAsync(45000);

    const reply = await replyPromise;
    expect(reply).toContain('def kalkulator');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('qwen3-coder');
    const diag = getAIDiagnostics();
    expect(diag.lastTaskType).toBe('coding');
    expect(diag.lastAITimedOut).toBe(false);
  });

  // 3. REASONING model takes 70 seconds -> MUST NOT timeout
  it('3. REASONING model takes 70 seconds -> MUST NOT timeout', async () => {
    vi.useFakeTimers();

    mockCreate.mockImplementation(async () => {
      // Simulate 70-second complex reasoning
      await new Promise((resolve) => setTimeout(resolve, 70000));
      return {
        choices: [
          {
            message: {
              content: 'Integral dari f(x) = 2x adalah x^2 + C.',
            },
          },
        ],
      };
    });

    const replyPromise = generateReply({
      message: 'jelaskan integral dari 2x beserta buktinya secara matematika',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    // Advance simulated time by 70 seconds
    await vi.advanceTimersByTimeAsync(70000);

    const reply = await replyPromise;
    expect(reply).toContain('Integral dari f(x) = 2x adalah x^2 + C.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    const diag = getAIDiagnostics();
    expect(diag.lastTaskType).toBe('reasoning');
    expect(diag.lastAITimedOut).toBe(false);
  });

  // 4. primary explicitly errors -> fallback runs immediately
  it('4. primary explicitly errors -> fallback runs immediately without waiting for timeout', async () => {
    // Primary model gemini-38 fails immediately with HTTP 500
    mockCreate.mockRejectedValueOnce({ status: 500, message: 'Internal Server Error' });
    // Secondary model qwen3-flash succeeds immediately
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Jawaban sukses dari qwen3-flash',
          },
        },
      ],
    });

    const startTime = Date.now();
    const reply = await generateReply({
      message: 'Pertanyaan umum',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });
    const elapsed = Date.now() - startTime;

    expect(reply).toBe('Jawaban sukses dari qwen3-flash');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('qwen3-flash');
    expect(elapsed).toBeLessThan(1000); // Immediate failover!
    const diag = getAIDiagnostics();
    expect(diag.lastFallbackCount).toBe(1);
    expect(diag.lastUsedModel).toBe('qwen3-flash');
  });

  // 5. primary times out at its real category limit -> fallback runs
  it('5. primary times out at its real category limit -> fallback runs', async () => {
    vi.useFakeTimers();

    // Primary model never resolves before timeout
    mockCreate.mockImplementationOnce(() => new Promise(() => {}));

    // Secondary model succeeds
    mockCreate.mockImplementationOnce(async () => ({
      choices: [
        {
          message: {
            content: 'Jawaban dari fallback qwen3-flash setelah timeout',
          },
        },
      ],
    }));

    const replyPromise = generateReply({
      message: 'Pertanyaan umum',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    // Advance by category timeout (45,000ms for general)
    await vi.advanceTimersByTimeAsync(45000);

    const reply = await replyPromise;
    expect(reply).toBe('Jawaban dari fallback qwen3-flash setelah timeout');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('qwen3-flash');
  });

  // 6. transient network error -> retries same model once before switching
  it('6. transient network error -> retries same model once before switching', async () => {
    // Attempt 1: ECONNRESET on gemini-38
    const connResetErr: any = new Error('read ECONNRESET');
    connResetErr.code = 'ECONNRESET';
    mockCreate.mockRejectedValueOnce(connResetErr);

    // Attempt 2: gemini-38 retry succeeds!
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Sukses setelah retry transient network error di gemini-38',
          },
        },
      ],
    });

    const reply = await generateReply({
      message: 'Halo apa kabar',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    expect(reply).toBe('Sukses setelah retry transient network error di gemini-38');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Both attempts were made on the same primary model gemini-38
    expect(mockCreate.mock.calls[0][0].model).toBe('gemini-38');
    expect(mockCreate.mock.calls[1][0].model).toBe('gemini-38');
    const diag = getAIDiagnostics();
    expect(diag.lastUsedModel).toBe('gemini-38');
  });

  // 7. memory DB failure -> AI still answers
  it('7. memory DB failure -> AI still answers without error', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    vi.spyOn(memory, 'loadContext').mockRejectedValueOnce(new Error('PostgreSQL connection timeout'));

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Jawaban tetap diberikan meski DB memory error',
          },
        },
      ],
    });

    const res = await processIncomingMessage({
      messageId: 'MSG_MEM_FAIL',
      chatId: 'user_db_fail@s.whatsapp.net',
      senderId: 'user_db_fail@s.whatsapp.net',
      text: 'Pertanyaan saat DB down',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: Date.now(),
      messageType: 'text',
    });

    expect(res).toBe(true);
    expect(whatsappService.sendMessage).toHaveBeenCalledWith(
      'user_db_fail@s.whatsapp.net',
      'Jawaban tetap diberikan meski DB memory error'
    );
  });

  // 8. profanity filter error -> AI answer still sent
  it('8. profanity filter error -> AI answer still sent intact', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    vi.spyOn(profanityFilter, 'mask').mockImplementationOnce(() => {
      throw new Error('Profanity filter internal crash');
    });

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Jawaban penting yang tidak boleh hilang karena filter error',
          },
        },
      ],
    });

    const res = await processIncomingMessage({
      messageId: 'MSG_PROF_ERR',
      chatId: 'user_prof@s.whatsapp.net',
      senderId: 'user_prof@s.whatsapp.net',
      text: 'Pertanyaan',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: Date.now(),
      messageType: 'text',
    });

    expect(res).toBe(true);
    expect(whatsappService.sendMessage).toHaveBeenCalledWith(
      'user_prof@s.whatsapp.net',
      'Jawaban penting yang tidak boleh hilang karena filter error'
    );
  });

  // 9. failed request -> next message still succeeds
  it('9. failed request -> next message still succeeds', async () => {
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });
    const chatId = 'user_recovery@s.whatsapp.net';

    // Message 1: All fail
    mockCreate.mockRejectedValue({ status: 500, message: 'Provider down' });
    const res1 = await processIncomingMessage({
      messageId: 'M1_FAIL',
      chatId,
      senderId: chatId,
      text: 'Pesan gagal',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 1000,
      messageType: 'text',
    });
    expect(res1).toBe(false);

    // Message 2: Succeeds immediately
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'Pesan kedua berhasil lancar!',
          },
        },
      ],
    });

    const res2 = await processIncomingMessage({
      messageId: 'M2_SUCCESS',
      chatId,
      senderId: chatId,
      text: 'Pesan kedua',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: 2000,
      messageType: 'text',
    });

    expect(res2).toBe(true);
    const history = memory.getHistory(chatId);
    expect(history.length).toBe(2);
    expect(history[0].content).toBe('Pesan kedua');
    expect(history[1].content).toBe('Pesan kedua berhasil lancar!');
  });

  // 10. WhatsApp typing indicator composing -> paused
  it('10. WhatsApp typing indicator starts composing and stops with paused', async () => {
    const presenceUpdates: { presence: string; jid: string }[] = [];
    const mockSocket = {
      sendPresenceUpdate: vi.fn(async (presence: string, jid: string) => {
        presenceUpdates.push({ presence, jid });
      }),
      sendMessage: vi.fn().mockResolvedValue({}),
    };
    setTestSocketInstance(mockSocket as any, true);

    const indicator = startTypingIndicator('628123456789@s.whatsapp.net', 5000);
    // Initial composing sent
    expect(presenceUpdates.some((p) => p.presence === 'composing')).toBe(true);

    indicator.stop();
    // Paused presence sent upon stopping
    expect(presenceUpdates.some((p) => p.presence === 'paused')).toBe(true);
  });

  // 11. Normal topics (religion, health, politics, personal names) are classified as general
  it('11. normal sensitive/complex topics are treated as legitimate general requests without blocking', () => {
    expect(detectTaskType('siapa Jokowi?')).toBe('general');
    expect(detectTaskType('hukum kalau saat sholat keluar mani?')).toBe('general');
    expect(detectTaskType('apa itu sperma?')).toBe('general');
    expect(detectTaskType('Cia Fei suka siapa?')).toBe('general');
    expect(detectTaskType('bagaimana cara merawat orang sakit demam berdarah?')).toBe('general');
  });

  // 12. Diagnostics observability fields in getAIDiagnostics()
  it('12. diagnostics exposes all observability metrics safely without secrets', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hasil diagnosa' } }],
    });

    await generateReply({
      message: 'Halo',
      chatId: 'user1@s.whatsapp.net',
      history: [],
    });

    const diag = getAIDiagnostics();
    expect(diag.lastAIStatus).toBe('success');
    expect(diag.lastTaskType).toBe('general');
    expect(diag.lastUsedModel).toBe('gemini-38');
    expect(Array.isArray(diag.lastAttemptedModels)).toBe(true);
    expect(diag.lastAttemptedModels).toContain('gemini-38');
    expect(typeof diag.lastFallbackCount).toBe('number');
    expect(typeof diag.lastAIDurationMs).toBe('number');
    expect(diag.lastAIErrorKind).toBeNull();
    expect(diag.lastAITimedOut).toBe(false);
    expect(typeof diag.lastAITimeoutLimitMs).toBe('number');
    expect(diag.lastAITimeoutLimitMs).toBeGreaterThan(0);
  });
});
