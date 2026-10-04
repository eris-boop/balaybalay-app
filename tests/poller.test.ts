/**
 * Tests for Polling Service (GET /wa-api/inbox)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startPoller,
  stopPoller,
  pollOnce,
  getPollerStatus,
} from '../src/services/poller';
import * as whatsappService from '../src/services/whatsapp';
import * as geminiService from '../src/services/gemini';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';

describe('VPSMurah Inbox Poller Service', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    stopPoller();
  });

  afterEach(() => {
    stopPoller();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('1. polling GET ke endpoint yang benar', async () => {
    let capturedUrl = '';
    let capturedMethod = '';

    globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo | URL, options?: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = options?.method || 'GET';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'success', data: [] }),
      } as unknown as Response);
    });

    await pollOnce();

    expect(capturedUrl).toBe('https://my.vpsmurah.co.id/api/svc/v1/wa-api/inbox');
    expect(capturedMethod).toBe('GET');
  });

  it('2. Authorization Bearer digunakan', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = vi.fn().mockImplementation((_url: RequestInfo | URL, options?: RequestInit) => {
      capturedHeaders = (options?.headers as Record<string, string>) || {};
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      } as unknown as Response);
    });

    await pollOnce();

    expect(capturedHeaders['Authorization']).toBe(`Bearer ${config.vpsmurahApiKey}`);
    expect(capturedHeaders['Accept']).toBe('application/json');
  });

  it('3. response message diproses dan dibalas', async () => {
    const geminiSpy = vi
      .spyOn(geminiService, 'generateReply')
      .mockResolvedValue('Jawaban AI untuk kamu');
    const sendSpy = vi
      .spyOn(whatsappService, 'sendMessage')
      .mockResolvedValue({ success: true });

    const inboxPayload = {
      status: 'success',
      data: [
        {
          id: 'INBOX_MSG_001',
          from: '628111222333@s.whatsapp.net',
          text: 'Halo apa kabar bot?',
          pushName: 'User Test',
          timestamp: Date.now(),
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(inboxPayload),
    } as unknown as Response);

    await pollOnce();

    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Halo apa kabar bot?',
      })
    );
    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringContaining('628111222333'),
      'Jawaban AI untuk kamu'
    );
  });

  it('4. duplicate message tidak diproses dua kali', async () => {
    const geminiSpy = vi
      .spyOn(geminiService, 'generateReply')
      .mockResolvedValue('Jawaban AI');
    const sendSpy = vi
      .spyOn(whatsappService, 'sendMessage')
      .mockResolvedValue({ success: true });

    const duplicatePayload = {
      data: [
        {
          id: 'DEDUP_MSG_999',
          from: '628999888777@s.whatsapp.net',
          text: 'Pesan unik berulang',
          timestamp: 1690000000000,
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(duplicatePayload),
    } as unknown as Response);

    // First cycle: should process
    await pollOnce();
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Second cycle: same messageId in inbox, should be ignored
    await pollOnce();
    expect(geminiSpy).toHaveBeenCalledTimes(1); // Still 1, NOT called again
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("5. bot's own message diabaikan", async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply');

    const ownMessagePayload = {
      data: [
        {
          id: 'OWN_MSG_001',
          from: `${config.botWhatsappNumber}@s.whatsapp.net`,
          text: 'Pesan dari bot sendiri',
          isFromMe: true,
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(ownMessagePayload),
    } as unknown as Response);

    await pollOnce();

    expect(geminiSpy).not.toHaveBeenCalled();
  });

  it('6. group tanpa mention diabaikan', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply');

    const groupPayload = {
      data: [
        {
          id: 'GROUP_NO_TAG_001',
          chatId: '120363001234567890@g.us',
          sender: '6281234567890@s.whatsapp.net',
          text: 'Halo kawan-kawan di grup!',
          isGroup: true,
          mentionedIds: [],
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(groupPayload),
    } as unknown as Response);

    await pollOnce();

    expect(geminiSpy).not.toHaveBeenCalled();
  });

  it('7. group dengan mention diproses dan mention dihapus', async () => {
    const geminiSpy = vi
      .spyOn(geminiService, 'generateReply')
      .mockResolvedValue('Fotosintesis adalah proses...');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const groupMentionPayload = {
      data: [
        {
          id: 'GROUP_TAGGED_001',
          chatId: '120363001234567890@g.us',
          sender: '6281234567890@s.whatsapp.net',
          text: `@${config.botWhatsappNumber} jelaskan fotosintesis`,
          isGroup: true,
          mentionedIds: [`${config.botWhatsappNumber}@s.whatsapp.net`],
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(groupMentionPayload),
    } as unknown as Response);

    await pollOnce();

    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'jelaskan fotosintesis', // Mention stripped
      })
    );
  });

  it('8. private chat diproses jika enabled', async () => {
    const geminiSpy = vi
      .spyOn(geminiService, 'generateReply')
      .mockResolvedValue('Halo juga!');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const dmPayload = {
      data: [
        {
          id: 'DM_MSG_001',
          from: '628555666777@s.whatsapp.net',
          text: 'Halo ini chat pribadi',
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(dmPayload),
    } as unknown as Response);

    await pollOnce();

    expect(geminiSpy).toHaveBeenCalled();
  });

  it('9. 401 tidak crash process', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as unknown as Response);

    // Should complete cleanly without throwing
    await expect(pollOnce()).resolves.not.toThrow();
  });

  it('10. 429 tidak crash process', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limit exceeded'),
    } as unknown as Response);

    await expect(pollOnce()).resolves.not.toThrow();
  });

  it('11. 500 tidak crash process', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal server error'),
    } as unknown as Response);

    await expect(pollOnce()).resolves.not.toThrow();
  });

  it('12. timeout tidak crash process', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abortErr);

    await expect(pollOnce()).resolves.not.toThrow();
  });

  it('13. overlapping polling tidak terjadi', async () => {
    let callCount = 0;
    let resolveFirstFetch: () => void;

    const slowPromise = new Promise<Response>((resolve) => {
      resolveFirstFetch = () =>
        resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        } as unknown as Response);
    });

    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return slowPromise;
    });

    // Start first poll (hangs in flight)
    const firstPoll = pollOnce();

    // Trigger second poll immediately while first is in flight
    const secondPoll = pollOnce();

    // The second call must return immediately without calling fetch again
    await secondPoll;
    expect(callCount).toBe(1);

    // Resolve first poll
    resolveFirstFetch!();
    await firstPoll;
  });

  it('14. interval minimum 5000ms enforced even if requested lower', () => {
    vi.useFakeTimers();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as unknown as Response);

    // Attempt to configure 1000ms (1 second)
    startPoller(1000);

    const status = getPollerStatus();
    expect(status.running).toBe(true);
    // Must be clamped to minimum 5000ms
    expect(status.intervalMs).toBe(5000);

    stopPoller();
  });

  it('15. API key tidak bocor ke log/error', async () => {
    const errorSpy = vi.spyOn(logger.polling, 'error');

    // Simulate network error containing secret API key
    const secretError = new Error(
      `Network failure with Authorization: Bearer ${config.vpsmurahApiKey}`
    );
    globalThis.fetch = vi.fn().mockRejectedValue(secretError);

    await pollOnce();

    for (const call of errorSpy.mock.calls) {
      const loggedText = call.map(String).join(' ');
      expect(loggedText).not.toContain(config.vpsmurahApiKey);
      expect(loggedText).toContain('[REDACTED]');
    }

    errorSpy.mockRestore();
  });
});
