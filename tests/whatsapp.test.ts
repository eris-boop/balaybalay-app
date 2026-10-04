/**
 * Tests for WhatsApp sending service with VPSMurah API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendMessage } from '../src/services/whatsapp';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';

describe('WhatsApp Service - VPSMurah Integration', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    (config as { whatsappProvider: string }).whatsappProvider = 'vpsmurah';
    (config as { vpsmurahApiKey: string }).vpsmurahApiKey = 'test-secret-vpsmurah-key';
  });

  afterEach(() => {
    (config as { whatsappProvider: string }).whatsappProvider = 'baileys';
    globalThis.fetch = originalFetch;
  });

  it('1. send text berhasil - verifies URL, method, headers, and body format', async () => {
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;

    globalThis.fetch = vi.fn().mockImplementation((url: RequestInfo | URL, options?: RequestInit) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"status":"success"}'),
        json: () => Promise.resolve({ status: 'success' }),
      } as unknown as Response);
    });

    const result = await sendMessage('6281234567890', 'Halo test');

    expect(result.success).toBe(true);
    expect(capturedUrl).toBe('https://my.vpsmurah.co.id/api/svc/v1/wa-api/messages');
    expect(capturedOptions?.method).toBe('POST');
    expect(capturedOptions?.headers).toEqual({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.vpsmurahApiKey}`,
    });

    const parsedBody = JSON.parse(String(capturedOptions?.body));
    expect(parsedBody).toEqual({
      to: '6281234567890',
      text: 'Halo test',
    });
    // Ensure legacy / unwanted fields are NOT present
    expect(parsedBody).not.toHaveProperty('id');
    expect(parsedBody).not.toHaveProperty('message');
    expect(parsedBody).not.toHaveProperty('number');
    expect(parsedBody).not.toHaveProperty('phone');
    expect(parsedBody).not.toHaveProperty('recipient');
    expect(parsedBody).not.toHaveProperty('chat_id');
  });

  it('2. handles API 400 bad request error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"Invalid payload"}'),
    } as unknown as Response);

    const result = await sendMessage('6281234567890', 'Halo test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
    expect(result.error?.toLowerCase()).toContain('bad request');
  });

  it('3. handles API 401 unauthorized error (invalid API key)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":"Unauthorized"}'),
    } as unknown as Response);

    const result = await sendMessage('6281234567890', 'Halo test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error?.toLowerCase()).toContain('unauthorized');
  });

  it('4. handles API 429 rate limit error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('{"error":"Too Many Requests"}'),
    } as unknown as Response);

    const result = await sendMessage('6281234567890', 'Halo test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
    expect(result.error?.toLowerCase()).toContain('rate limit');
  });

  it('5. handles API 500 provider server error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"error":"Internal Server Error"}'),
    } as unknown as Response);

    const result = await sendMessage('6281234567890', 'Halo test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('6. handles timeout via AbortController abort signal', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    globalThis.fetch = vi.fn().mockRejectedValue(abortErr);

    const result = await sendMessage('6281234567890', 'Halo test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Request timed out');
  });

  it('7. nomor private dinormalisasi dan ID grup tidak dirusak', async () => {
    const bodies: Array<{ to: string; text: string }> = [];

    globalThis.fetch = vi.fn().mockImplementation((_url: RequestInfo | URL, options?: RequestInit) => {
      bodies.push(JSON.parse(String(options?.body)));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"status":"success"}'),
      } as unknown as Response);
    });

    // Case 1: Phone number with plus, spaces, dashes (+62 812-3456-7890)
    await sendMessage('+62 812-3456-7890', 'msg1');
    expect(bodies[0].to).toBe('6281234567890');

    // Case 2: Phone number with @s.whatsapp.net suffix
    await sendMessage('6281234567890@s.whatsapp.net', 'msg2');
    expect(bodies[1].to).toBe('6281234567890');

    // Case 3: Group chat identifier (must NOT strip @g.us or break format)
    await sendMessage('120363001234567890@g.us', 'msg3');
    expect(bodies[2].to).toBe('120363001234567890@g.us');
  });

  it('8. API key tidak pernah muncul di error maupun log', async () => {
    const errorSpy = vi.spyOn(logger.whatsapp, 'error');

    // Simulate network error containing secret API key
    const secretError = new Error(`Connection failed with Bearer ${config.vpsmurahApiKey}`);
    globalThis.fetch = vi.fn().mockRejectedValue(secretError);

    const result = await sendMessage('6281234567890', 'Halo test');

    expect(result.success).toBe(false);
    // Error returned to caller must NOT contain the raw API key
    expect(result.error).not.toContain(config.vpsmurahApiKey);
    expect(result.error).toContain('[REDACTED]');

    // Error logs must NOT contain the raw API key
    for (const call of errorSpy.mock.calls) {
      const loggedString = call.map(String).join(' ');
      expect(loggedString).not.toContain(config.vpsmurahApiKey);
    }

    errorSpy.mockRestore();
  });
});
