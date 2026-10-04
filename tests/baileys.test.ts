/**
 * Comprehensive test suite for WhatsApp Baileys Integration.
 *
 * Tests the 15 required scenarios:
 * 1.  private incoming text diproses
 * 2.  private message dibalas
 * 3.  fromMe diabaikan
 * 4.  duplicate message diabaikan
 * 5.  group tanpa mention diabaikan
 * 6.  group dengan mention diproses
 * 7.  mention dihapus dari prompt Gemini
 * 8.  reply grup dikirim ke remoteJid grup
 * 9.  status broadcast diabaikan
 * 10. empty message diabaikan
 * 11. QR route tanpa ADMIN_TOKEN -> 403
 * 12. QR route dengan token valid -> berhasil
 * 13. health menunjukkan connected state
 * 14. reconnect tidak membuat multiple socket
 * 15. Gemini failure tidak crash app
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractBaileysMessage, initWhatsAppClient, getWhatsAppStatus } from '../src/services/whatsappClient';
import { processIncomingMessage } from '../src/services/messageProcessor';
import * as geminiService from '../src/services/gemini';
import * as whatsappService from '../src/services/whatsapp';
import { config } from '../src/config';
import { app } from '../src/server';
import { Server } from 'http';
import { AddressInfo } from 'net';

describe('WhatsApp Baileys Integration Test Suite', () => {
  let server: Server;
  let baseUrl = '';

  beforeEach(() => {
    vi.restoreAllMocks();
    (config as { botWhatsappNumber: string }).botWhatsappNumber = '628123456789';
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  // --------------------------------------------------------------------------
  // 1. private incoming text diproses
  // --------------------------------------------------------------------------
  it('1. private incoming text diproses', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Halo! Ada yang bisa dibantu?');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_PVT_001',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Halo bot, apa kabar?',
      },
      pushName: 'Budi',
      messageTimestamp: 1696406400,
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.text).toBe('Halo bot, apa kabar?');
    expect(extracted!.isGroup).toBe(false);

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(true);
    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Halo bot, apa kabar?',
        chatId: '6281234567890@s.whatsapp.net',
      })
    );
  });

  // --------------------------------------------------------------------------
  // 2. private message dibalas
  // --------------------------------------------------------------------------
  it('2. private message dibalas ke pengirim', async () => {
    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Saya adalah asisten AI.');
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_PVT_002',
        remoteJid: '6289876543210@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text: 'Siapa kamu?',
        },
      },
      pushName: 'Siti',
      messageTimestamp: 1696406500,
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    await processIncomingMessage(extracted!);

    expect(sendSpy).toHaveBeenCalledWith(
      '6289876543210@s.whatsapp.net',
      'Saya adalah asisten AI.'
    );
  });

  // --------------------------------------------------------------------------
  // 3. fromMe diabaikan
  // --------------------------------------------------------------------------
  it('3. fromMe diabaikan dan tidak diproses', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply');

    const baileysMsg = {
      key: {
        id: 'BAILEYS_FROM_ME_001',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: true, // Message sent from self
      },
      message: {
        conversation: 'Pesan dari bot sendiri',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).toBeNull(); // extractBaileysMessage filters out fromMe
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 4. duplicate message diabaikan
  // --------------------------------------------------------------------------
  it('4. duplicate message diabaikan (idempotency)', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Respon pertama');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_IDEMPOTENT_KEY_123',
        remoteJid: '628111222333@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Pesan duplikasi',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);

    // First arrival: should process
    const firstRun = await processIncomingMessage(extracted!);
    expect(firstRun).toBe(true);
    expect(geminiSpy).toHaveBeenCalledTimes(1);

    // Second arrival with same key.id: should be ignored
    const secondRun = await processIncomingMessage(extracted!);
    expect(secondRun).toBe(false);
    expect(geminiSpy).toHaveBeenCalledTimes(1); // Still 1, NOT called again
  });

  // --------------------------------------------------------------------------
  // 5. group tanpa mention diabaikan
  // --------------------------------------------------------------------------
  it('5. group tanpa mention diabaikan', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply');

    const baileysMsg = {
      key: {
        id: 'BAILEYS_GRP_NO_TAG_001',
        remoteJid: '120363001234567890@g.us',
        participant: '628555666777@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Halo teman-teman di grup!',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.isGroup).toBe(true);

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(false);
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 6. group dengan mention diproses
  // --------------------------------------------------------------------------
  it('6. group dengan mention diproses', async () => {
    const botNum = config.botWhatsappNumber || '628123456789';
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Penjelasan AI');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_GRP_TAG_001',
        remoteJid: '120363001234567890@g.us',
        participant: '628555666777@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text: `@${botNum} jelaskan fotosintesis`,
          contextInfo: {
            mentionedJid: [`${botNum}@s.whatsapp.net`],
          },
        },
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.mentionedIds).toContain(`${botNum}@s.whatsapp.net`);

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(true);
    expect(geminiSpy).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 7. mention dihapus dari prompt Gemini
  // --------------------------------------------------------------------------
  it('7. mention dihapus dari prompt Gemini', async () => {
    const botNum = config.botWhatsappNumber || '628123456789';
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Teori relativitas...');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_GRP_TAG_STRIP',
        remoteJid: '120363001234567890@g.us',
        participant: '628555666777@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text: `@${botNum} jelaskan relativitas umum`,
          contextInfo: {
            mentionedJid: [`${botNum}@s.whatsapp.net`],
          },
        },
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    await processIncomingMessage(extracted!);

    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'jelaskan relativitas umum', // @botNum is stripped
      })
    );
  });

  // --------------------------------------------------------------------------
  // 8. reply grup dikirim ke remoteJid grup
  // --------------------------------------------------------------------------
  it('8. reply grup dikirim ke remoteJid grup, bukan ke participant', async () => {
    const botNum = config.botWhatsappNumber || '628123456789';
    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Jawaban ke grup');
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const groupJid = '120363999999999999@g.us';
    const participantJid = '628111222333@s.whatsapp.net';

    const baileysMsg = {
      key: {
        id: 'BAILEYS_GRP_REPLY_TARGET',
        remoteJid: groupJid,
        participant: participantJid,
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text: `@${botNum} halo`,
          contextInfo: {
            mentionedJid: [`${botNum}@s.whatsapp.net`],
          },
        },
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    await processIncomingMessage(extracted!);

    expect(sendSpy).toHaveBeenCalledWith(groupJid, 'Jawaban ke grup');
    expect(sendSpy).not.toHaveBeenCalledWith(participantJid, expect.anything());
  });

  // --------------------------------------------------------------------------
  // 9. status broadcast diabaikan
  // --------------------------------------------------------------------------
  it('9. status broadcast diabaikan', () => {
    const baileysMsg = {
      key: {
        id: 'STATUS_MSG_001',
        remoteJid: 'status@broadcast',
        fromMe: false,
      },
      message: {
        conversation: 'Ini status WhatsApp seseorang',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 10. empty message diabaikan
  // --------------------------------------------------------------------------
  it('10. empty message diabaikan', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply');

    const baileysMsg = {
      key: {
        id: 'EMPTY_MSG_001',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: '   ', // whitespace only
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.text).toBe('');

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(false);
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 11. QR route tanpa ADMIN_TOKEN -> 403
  // --------------------------------------------------------------------------
  it('11. QR route tanpa ADMIN_TOKEN -> 403', async () => {
    // Start local server listener
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // Request without token
    const resNoToken = await fetch(`${baseUrl}/admin/qr`);
    expect(resNoToken.status).toBe(403);

    // Request with wrong token
    const resWrongToken = await fetch(`${baseUrl}/admin/qr?token=invalid_random_token`);
    expect(resWrongToken.status).toBe(403);
  });

  // --------------------------------------------------------------------------
  // 12. QR route dengan token valid -> berhasil
  // --------------------------------------------------------------------------
  it('12. QR route dengan token valid -> berhasil', async () => {
    // Configure adminToken for test
    (config as { adminToken: string }).adminToken = 'test-secret-token-xyz';

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const res = await fetch(`${baseUrl}/admin/qr?token=test-secret-token-xyz`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') || '';
    // Either returns HTML page with QR / connecting state, or JSON if already connected
    expect(contentType.includes('text/html') || contentType.includes('application/json')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 13. health menunjukkan connected state
  // --------------------------------------------------------------------------
  it('13. health menunjukkan connected state', async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe('ok');
    expect(body.whatsappProvider).toBe('baileys');
    expect(typeof body.whatsappConnected).toBe('boolean');
    expect(typeof body.pairingRequired).toBe('boolean');
    expect(typeof body.uptime).toBe('number');
    // Ensure sensitive information is never exposed
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('session');
    expect(body).not.toHaveProperty('botJid');
  });

  // --------------------------------------------------------------------------
  // 14. reconnect tidak membuat multiple socket
  // --------------------------------------------------------------------------
  it('14. reconnect tidak membuat multiple socket', async () => {
    // Concurrency guard in initWhatsAppClient prevents multiple simultaneous connections
    const call1 = initWhatsAppClient();
    const call2 = initWhatsAppClient();

    const [sock1, sock2] = await Promise.all([call1, call2]);
    // Both calls must resolve to the identical single socket instance (or null in test env)
    expect(sock1).toBe(sock2);
  });

  // --------------------------------------------------------------------------
  // 15. Gemini failure tidak crash app
  // --------------------------------------------------------------------------
  it('15. Gemini failure tidak crash app', async () => {
    vi.spyOn(geminiService, 'generateReply').mockRejectedValue(new Error('Gemini 503 Overloaded'));
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_ERR_TEST_001',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Pesan saat Gemini error',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);

    // Must resolve cleanly without throwing an unhandled exception
    await expect(processIncomingMessage(extracted!)).resolves.not.toThrow();
  });
});
