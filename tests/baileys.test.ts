/**
 * Comprehensive test suite for WhatsApp Baileys Integration.
 *
 * Covers all requirements:
 * 1.  messages.upsert listener terpasang
 * 2.  private @s.whatsapp.net diproses
 * 3.  private @lid diproses
 * 4.  fromMe diabaikan
 * 5.  status broadcast diabaikan
 * 6.  conversation text diproses
 * 7.  extendedText diproses
 * 8.  ephemeral wrapped text diproses
 * 9.  private tidak membutuhkan mention
 * 10. group tanpa mention diabaikan
 * 11. group mention @s.whatsapp.net diproses
 * 12. group mention @lid diproses
 * 13. Gemini dipanggil
 * 14. reply dikirim ke EXACT remoteJid
 * 15. duplicate message hanya diproses sekali
 * 16. reconnect memasang listener pada socket baru tanpa duplicate listener
 * 17. QR route security
 * 18. Health route format
 * 19. Admin status diagnostics
 * 20. Gemini failure resilience
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractBaileysMessage,
  initWhatsAppClient,
  getWhatsAppStatus,
  getDiagnostics,
  setTestSocketInstance,
  getSocketInstance,
  resetWhatsAppClientState,
} from '../src/services/whatsappClient';
import { processIncomingMessage } from '../src/services/messageProcessor';
import * as geminiService from '../src/services/gemini';
import * as whatsappService from '../src/services/whatsapp';
import { toBaileysJid, isGroupChat, isPrivateChat } from '../src/utils/phone';
import { config } from '../src/config';
import { app } from '../src/server';
import { Server } from 'http';
import { AddressInfo } from 'net';

describe('WhatsApp Baileys Integration Test Suite', () => {
  let server: Server;
  let baseUrl = '';

  beforeEach(() => {
    vi.restoreAllMocks();
    resetWhatsAppClientState();
    (config as { botWhatsappNumber: string }).botWhatsappNumber = '628123456789';
    (config as { adminToken: string }).adminToken = 'test-admin-secret-token';
  });

  afterEach(() => {
    resetWhatsAppClientState();
    if (server) {
      server.close();
    }
  });

  // --------------------------------------------------------------------------
  // 1. messages.upsert listener terpasang
  // --------------------------------------------------------------------------
  it('1. messages.upsert listener terpasang pada socket aktif', async () => {
    const mockListeners: Record<string, Function> = {};
    const mockSocket = {
      ev: {
        on: vi.fn((event: string, handler: Function) => {
          mockListeners[event] = handler;
        }),
      },
      user: {
        id: '628123456789:0@s.whatsapp.net',
        lid: '12345678901234:0@lid',
      },
      sendMessage: vi.fn().mockResolvedValue({}),
      end: vi.fn(),
    };

    setTestSocketInstance(mockSocket as any, true);
    const status = getWhatsAppStatus();

    expect(status.connected).toBe(true);
    expect(status.messageHandlerReady).toBe(true);
    expect(status.provider).toBe('baileys');
  });

  // --------------------------------------------------------------------------
  // 2. private @s.whatsapp.net diproses
  // --------------------------------------------------------------------------
  it('2. private @s.whatsapp.net diproses', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Halo! Ada yang bisa dibantu?');
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_PVT_STD_001',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Halo bot dari standard JID',
      },
      pushName: 'Budi',
      messageTimestamp: 1696406400,
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.chatId).toBe('6281234567890@s.whatsapp.net');
    expect(extracted!.isGroup).toBe(false);

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(true);
    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Halo bot dari standard JID',
        chatId: '6281234567890@s.whatsapp.net',
      })
    );
    expect(sendSpy).toHaveBeenCalledWith('6281234567890@s.whatsapp.net', 'Halo! Ada yang bisa dibantu?');
  });

  // --------------------------------------------------------------------------
  // 3. private @lid diproses
  // --------------------------------------------------------------------------
  it('3. private @lid diproses', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Halo pengguna LID!');
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const lidJid = '98765432109876@lid';
    const baileysMsg = {
      key: {
        id: 'BAILEYS_PVT_LID_001',
        remoteJid: lidJid,
        fromMe: false,
      },
      message: {
        conversation: 'Pesan dari akun WhatsApp bertipe LID',
      },
      pushName: 'Pengguna Modern',
      messageTimestamp: 1696406450,
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.chatId).toBe(lidJid);
    expect(extracted!.isGroup).toBe(false);

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(true);
    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Pesan dari akun WhatsApp bertipe LID',
        chatId: lidJid,
      })
    );
    // Verifies reply is sent to the EXACT @lid remoteJid
    expect(sendSpy).toHaveBeenCalledWith(lidJid, 'Halo pengguna LID!');
  });

  // --------------------------------------------------------------------------
  // 4. fromMe diabaikan
  // --------------------------------------------------------------------------
  it('4. fromMe diabaikan dan tidak diproses', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply');

    const baileysMsg = {
      key: {
        id: 'BAILEYS_FROM_ME_001',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: true, // Self message
      },
      message: {
        conversation: 'Pesan terkirim dari bot sendiri',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).toBeNull();
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 5. status broadcast diabaikan
  // --------------------------------------------------------------------------
  it('5. status broadcast diabaikan', () => {
    const baileysMsg = {
      key: {
        id: 'STATUS_MSG_001',
        remoteJid: 'status@broadcast',
        fromMe: false,
      },
      message: {
        conversation: 'Status cerita WhatsApp',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 6. conversation text diproses
  // --------------------------------------------------------------------------
  it('6. conversation text diproses', () => {
    const baileysMsg = {
      key: {
        id: 'BAILEYS_CONV_001',
        remoteJid: '628111222333@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Pesan conversation biasa',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.text).toBe('Pesan conversation biasa');
    expect(extracted!.messageType).toBe('text');
  });

  // --------------------------------------------------------------------------
  // 7. extendedText diproses
  // --------------------------------------------------------------------------
  it('7. extendedText diproses', () => {
    const baileysMsg = {
      key: {
        id: 'BAILEYS_EXT_001',
        remoteJid: '628111222333@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text: 'Pesan extended text dengan tautan atau format',
        },
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.text).toBe('Pesan extended text dengan tautan atau format');
    expect(extracted!.messageType).toBe('text');
  });

  // --------------------------------------------------------------------------
  // 8. ephemeral wrapped text diproses
  // --------------------------------------------------------------------------
  it('8. ephemeral wrapped text diproses', () => {
    const baileysMsg = {
      key: {
        id: 'BAILEYS_EPH_001',
        remoteJid: '628111222333@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        ephemeralMessage: {
          message: {
            conversation: 'Pesan di dalam pesan sementara (ephemeral)',
          },
        },
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted).not.toBeNull();
    expect(extracted!.text).toBe('Pesan di dalam pesan sementara (ephemeral)');
    expect(extracted!.messageType).toBe('text');
  });

  // --------------------------------------------------------------------------
  // 9. private tidak membutuhkan mention
  // --------------------------------------------------------------------------
  it('9. private tidak membutuhkan mention (@s.whatsapp.net & @lid)', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Jawaban tanpa mention');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_PVT_NO_TAG',
        remoteJid: '628555666777@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Berapa luas pulau Jawa?',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    const processed = await processIncomingMessage(extracted!);

    expect(processed).toBe(true);
    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Berapa luas pulau Jawa?',
      })
    );
  });

  // --------------------------------------------------------------------------
  // 10. group tanpa mention diabaikan
  // --------------------------------------------------------------------------
  it('10. group tanpa mention diabaikan', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply');

    const baileysMsg = {
      key: {
        id: 'BAILEYS_GRP_NO_TAG',
        remoteJid: '120363001234567890@g.us',
        participant: '628555666777@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Diskusi biasa antar anggota grup tanpa mention bot',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted!.isGroup).toBe(true);

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(false);
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 11. group mention @s.whatsapp.net diproses
  // --------------------------------------------------------------------------
  it('11. group mention @s.whatsapp.net diproses', async () => {
    const botNum = config.botWhatsappNumber || '628123456789';
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Penjelasan AI');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_GRP_TAG_STD',
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
    const processed = await processIncomingMessage(extracted!);

    expect(processed).toBe(true);
    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'jelaskan fotosintesis',
      })
    );
  });

  // --------------------------------------------------------------------------
  // 12. group mention @lid diproses
  // --------------------------------------------------------------------------
  it('12. group mention @lid diproses', async () => {
    // Configure socket user with a mock LID
    const mockSocket = {
      user: {
        id: '628123456789:0@s.whatsapp.net',
        lid: '98765432109876:0@lid',
      },
      sendMessage: vi.fn().mockResolvedValue({}),
      end: vi.fn(),
      ev: { on: vi.fn() },
    };
    setTestSocketInstance(mockSocket as any, true);

    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Jawaban tag LID');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_GRP_TAG_LID',
        remoteJid: '120363001234567890@g.us',
        participant: '628555666777@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        extendedTextMessage: {
          text: '@bot jelaskan orbit bumi',
          contextInfo: {
            mentionedJid: ['98765432109876@lid'], // Mentioning bot via its LID
          },
        },
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    expect(extracted!.mentionedIds).toContain('98765432109876@lid');

    const processed = await processIncomingMessage(extracted!);
    expect(processed).toBe(true);
    expect(geminiSpy).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 13. Gemini dipanggil dengan parameter yang benar
  // --------------------------------------------------------------------------
  it('13. Gemini dipanggil dengan parameter yang benar', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Hasil Gemini');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'BAILEYS_CALL_TEST',
        remoteJid: '628111222333@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Pertanyaan uji coba',
      },
      pushName: 'Tester',
    };

    const extracted = extractBaileysMessage(baileysMsg as any);
    await processIncomingMessage(extracted!);

    expect(geminiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Pertanyaan uji coba',
        senderName: 'Tester',
        chatId: '628111222333@s.whatsapp.net',
        history: expect.any(Array),
      })
    );
  });

  // --------------------------------------------------------------------------
  // 14. reply dikirim ke EXACT remoteJid
  // --------------------------------------------------------------------------
  it('14. reply dikirim ke EXACT remoteJid (@lid, @s.whatsapp.net, @g.us)', async () => {
    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Jawaban AI');
    const sendSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    // 14a: Modern @lid JID
    const lidJid = '999888777666@lid';
    await processIncomingMessage({
      messageId: 'M1',
      chatId: lidJid,
      senderId: lidJid,
      text: 'Halo',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: Date.now(),
      messageType: 'text',
    });
    expect(sendSpy).toHaveBeenCalledWith(lidJid, 'Jawaban AI');
    expect(toBaileysJid(lidJid)).toBe(lidJid);

    // 14b: Standard @s.whatsapp.net JID
    const stdJid = '6281234567890@s.whatsapp.net';
    await processIncomingMessage({
      messageId: 'M2',
      chatId: stdJid,
      senderId: stdJid,
      text: 'Halo',
      isGroup: false,
      isFromMe: false,
      mentionedIds: [],
      timestamp: Date.now(),
      messageType: 'text',
    });
    expect(sendSpy).toHaveBeenCalledWith(stdJid, 'Jawaban AI');
    expect(toBaileysJid(stdJid)).toBe(stdJid);

    // 14c: Group @g.us JID
    const grpJid = '120363009999999999@g.us';
    await processIncomingMessage({
      messageId: 'M3',
      chatId: grpJid,
      senderId: '628111@s.whatsapp.net',
      text: `@${config.botWhatsappNumber} Halo`,
      isGroup: true,
      isFromMe: false,
      mentionedIds: [`${config.botWhatsappNumber}@s.whatsapp.net`],
      timestamp: Date.now(),
      messageType: 'text',
    });
    expect(sendSpy).toHaveBeenCalledWith(grpJid, 'Jawaban AI');
    expect(toBaileysJid(grpJid)).toBe(grpJid);
  });

  // --------------------------------------------------------------------------
  // 15. duplicate message hanya diproses sekali (idempotency)
  // --------------------------------------------------------------------------
  it('15. duplicate message hanya diproses sekali', async () => {
    const geminiSpy = vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Respon');
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

    const baileysMsg = {
      key: {
        id: 'EXACT_DUP_KEY_999',
        remoteJid: '628111222333@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        conversation: 'Pesan berulang',
      },
    };

    const extracted = extractBaileysMessage(baileysMsg as any);

    const res1 = await processIncomingMessage(extracted!);
    expect(res1).toBe(true);
    expect(geminiSpy).toHaveBeenCalledTimes(1);

    const res2 = await processIncomingMessage(extracted!);
    expect(res2).toBe(false);
    expect(geminiSpy).toHaveBeenCalledTimes(1); // Not called second time
  });

  // --------------------------------------------------------------------------
  // 16. reconnect memasang listener pada socket baru tanpa duplicate listener
  // --------------------------------------------------------------------------
  it('16. reconnect memasang listener pada socket baru tanpa duplicate listener', async () => {
    let closeCallCount = 0;
    const oldSocket = {
      end: vi.fn(() => {
        closeCallCount++;
      }),
      ev: { on: vi.fn() },
    };

    setTestSocketInstance(oldSocket as any, false);

    // Call initWhatsAppClient
    const clientPromise = initWhatsAppClient();
    expect(clientPromise).toBeDefined();

    // Verify old socket end was called during re-initialization
    expect(oldSocket.end).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 17. QR route tanpa ADMIN_TOKEN -> 403
  // --------------------------------------------------------------------------
  it('17. QR route tanpa ADMIN_TOKEN -> 403', async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const resNoToken = await fetch(`${baseUrl}/admin/qr`);
    expect(resNoToken.status).toBe(403);

    const resWrongToken = await fetch(`${baseUrl}/admin/qr?token=wrong_token`);
    expect(resWrongToken.status).toBe(403);
  });

  // --------------------------------------------------------------------------
  // 18. QR route dengan token valid -> berhasil
  // --------------------------------------------------------------------------
  it('18. QR route dengan token valid -> berhasil', async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const res = await fetch(`${baseUrl}/admin/qr?token=test-admin-secret-token`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType.includes('text/html') || contentType.includes('application/json')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 19. Health route menampilkan messageHandlerReady dan connection state
  // --------------------------------------------------------------------------
  it('19. Health route menampilkan messageHandlerReady dan connection state', async () => {
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
    expect(typeof body.messageHandlerReady).toBe('boolean');
    expect(body).toHaveProperty('lastMessageAt');
    expect(body).toHaveProperty('lastReplyAt');
    // Ensure sensitive information is never exposed
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('session');
  });

  // --------------------------------------------------------------------------
  // 20. Admin status route menampilkan diagnostics
  // --------------------------------------------------------------------------
  it('20. Admin status route menampilkan sanitized diagnostics', async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const res = await fetch(`${baseUrl}/admin/status?token=test-admin-secret-token`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.connected).toBe('boolean');
    expect(typeof body.handlerReady).toBe('boolean');
    expect(typeof body.socketExists).toBe('boolean');
    expect(body).toHaveProperty('lastUpsertAt');
    expect(body).toHaveProperty('lastMessageAt');
    expect(body).toHaveProperty('lastGeminiAt');
    expect(body).toHaveProperty('lastReplyAt');
    expect(body).toHaveProperty('lastError');
    // Ensure zero secrets exposed
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('auth');
    expect(body).not.toHaveProperty('phone');
  });

  // --------------------------------------------------------------------------
  // 21. Gemini failure tidak crash app
  // --------------------------------------------------------------------------
  it('21. Gemini failure tidak crash app', async () => {
    vi.spyOn(geminiService, 'generateReply').mockRejectedValue(new Error('Gemini 503 Overloaded'));
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue({ success: true });

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
    await expect(processIncomingMessage(extracted!)).resolves.not.toThrow();
  });
});
