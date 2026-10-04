/**
 * Tests for webhook processing logic.
 * Uses the VPSMurah adapter to test payload parsing.
 */

import { describe, it, expect } from 'vitest';
import { parseVpsmurahWebhook } from '../src/providers/vpsmurah';

describe('parseVpsmurahWebhook', () => {
  it('parses Baileys-format message correctly', () => {
    const payload = {
      event: 'message',
      data: {
        key: {
          id: 'MSG_001',
          remoteJid: '120363001234567890@g.us',
          fromMe: false,
          participant: '6281234567890@s.whatsapp.net',
        },
        pushName: 'John',
        messageTimestamp: 1696406400,
        message: {
          conversation: 'Hello bot!',
        },
      },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe('120363001234567890@g.us');
    expect(result!.senderId).toBe('6281234567890@s.whatsapp.net');
    expect(result!.senderName).toBe('John');
    expect(result!.text).toBe('Hello bot!');
    expect(result!.isGroup).toBe(true);
    expect(result!.isFromMe).toBe(false);
    expect(result!.messageType).toBe('text');
  });

  it('parses extended text message with mentions', () => {
    const payload = {
      key: {
        id: 'MSG_002',
        remoteJid: '120363001234567890@g.us',
        fromMe: false,
        participant: '6281234567890@s.whatsapp.net',
      },
      pushName: 'Jane',
      messageTimestamp: 1696406500,
      message: {
        extendedTextMessage: {
          text: '@628999888777 explain black holes',
          contextInfo: {
            mentionedJid: ['628999888777@s.whatsapp.net'],
          },
        },
      },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('@628999888777 explain black holes');
    expect(result!.mentionedIds).toEqual(['628999888777@s.whatsapp.net']);
    expect(result!.messageType).toBe('text');
  });

  it('parses private chat message', () => {
    const payload = {
      key: {
        id: 'MSG_003',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      pushName: 'Alice',
      messageTimestamp: 1696406600,
      message: {
        conversation: 'Hi there!',
      },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe('6281234567890@s.whatsapp.net');
    expect(result!.isGroup).toBe(false);
    expect(result!.text).toBe('Hi there!');
  });

  it('identifies fromMe messages', () => {
    const payload = {
      key: {
        id: 'MSG_004',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: true,
      },
      message: {
        conversation: 'my own message',
      },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.isFromMe).toBe(true);
  });

  it('handles flat payload structure', () => {
    const payload = {
      messageId: 'MSG_005',
      chatId: '6281234567890@s.whatsapp.net',
      senderId: '6289876543210@s.whatsapp.net',
      senderName: 'Bob',
      text: 'flat structure hello',
      fromMe: false,
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('flat structure hello');
    expect(result!.chatId).toBe('6281234567890@s.whatsapp.net');
  });

  it('returns null for non-object body', () => {
    expect(parseVpsmurahWebhook(null)).toBeNull();
    expect(parseVpsmurahWebhook(undefined)).toBeNull();
    expect(parseVpsmurahWebhook('string')).toBeNull();
  });

  it('returns null for status events', () => {
    const payload = {
      event: 'connection.status',
      status: 'connected',
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).toBeNull();
  });

  it('handles image message (returns type image, caption as text)', () => {
    const payload = {
      key: {
        id: 'MSG_006',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        imageMessage: {
          caption: 'check this photo',
          mimetype: 'image/jpeg',
        },
      },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.messageType).toBe('image');
    expect(result!.text).toBe('check this photo');
  });

  it('handles audio message (returns type audio, no text)', () => {
    const payload = {
      key: {
        id: 'MSG_007',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
        },
      },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.messageType).toBe('audio');
    expect(result!.text).toBe('');
  });

  it('ignores typing/presence events', () => {
    expect(parseVpsmurahWebhook({ event: 'presence', type: 'typing' })).toBeNull();
    expect(parseVpsmurahWebhook({ event: 'typing' })).toBeNull();
    expect(parseVpsmurahWebhook({ type: 'receipt' })).toBeNull();
  });

  it('DM should be replied (isGroup=false)', () => {
    const payload = {
      key: {
        id: 'MSG_DM',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'DM hello' },
    };
    const result = parseVpsmurahWebhook(payload);
    expect(result!.isGroup).toBe(false);
  });
});

describe('webhook integration scenarios', () => {
  it('group message without mention should parse but bot logic should ignore', () => {
    const payload = {
      key: {
        id: 'MSG_GRP_NO_MENTION',
        remoteJid: '120363001234567890@g.us',
        fromMe: false,
        participant: '6281234567890@s.whatsapp.net',
      },
      message: { conversation: 'hello everyone, no mention here' },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.isGroup).toBe(true);
    expect(result!.mentionedIds).toEqual([]);
    // Business logic layer (webhook route) would check isBotMentioned and skip
  });

  it('group message with mention should parse with mentionedIds', () => {
    const payload = {
      key: {
        id: 'MSG_GRP_MENTION',
        remoteJid: '120363001234567890@g.us',
        fromMe: false,
        participant: '6281234567890@s.whatsapp.net',
      },
      message: {
        extendedTextMessage: {
          text: '@628999000111 what is photosynthesis',
          contextInfo: {
            mentionedJid: ['628999000111@s.whatsapp.net'],
          },
        },
      },
    };

    const result = parseVpsmurahWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.mentionedIds).toContain('628999000111@s.whatsapp.net');
  });

  it('duplicate message ID should be detected by idempotency service', () => {
    // This is tested at the service level; here we just verify parsing
    // produces a consistent messageId
    const payload = {
      key: {
        id: 'MSG_SAME_ID',
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'duplicate test' },
    };

    const result1 = parseVpsmurahWebhook(payload);
    const result2 = parseVpsmurahWebhook(payload);
    expect(result1!.messageId).toBe(result2!.messageId);
  });
});
