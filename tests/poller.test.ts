/**
 * Tests verifying that VPSMurah Inbox Poller is permanently disabled.
 * Incoming & outgoing WhatsApp messages are handled via Baileys WebSocket.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  startPoller,
  stopPoller,
  pollOnce,
  isPollerRunning,
  isPollActive,
  getPollerStatus,
} from '../src/services/poller';

describe('VPSMurah Inbox Poller (Permanently Disabled)', () => {
  it('startPoller returns false and does not start any interval', () => {
    const started = startPoller();
    expect(started).toBe(false);
    expect(isPollerRunning()).toBe(false);
  });

  it('stopPoller is safe to call without error', () => {
    expect(() => stopPoller()).not.toThrow();
    expect(isPollerRunning()).toBe(false);
  });

  it('pollOnce does not execute fetch requests to VPSMurah', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await pollOnce();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isPollActive()).toBe(false);
  });

  it('getPollerStatus reports running=false and intervalMs=0', () => {
    const status = getPollerStatus();
    expect(status).toEqual({
      running: false,
      intervalMs: 0,
    });
  });
});
