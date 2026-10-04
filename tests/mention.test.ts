/**
 * Tests for mention detection and stripping logic.
 */

import { describe, it, expect } from 'vitest';
import { isBotMentioned, stripBotMention } from '../src/services/mention';
import { IncomingMessage } from '../src/types/whatsapp';

const BOT_NUMBER = '628123456789';

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'test-msg-1',
    chatId: '120363001234567890@g.us',
    senderId: '6289876543210@s.whatsapp.net',
    senderName: 'Test User',
    text: '',
    isGroup: true,
    isFromMe: false,
    mentionedIds: [],
    ...overrides,
  };
}

describe('isBotMentioned', () => {
  it('returns true when bot JID is in mentionedIds', () => {
    const msg = makeMessage({
      text: '@628123456789 hello',
      mentionedIds: ['628123456789@s.whatsapp.net'],
    });
    expect(isBotMentioned(msg, BOT_NUMBER)).toBe(true);
  });

  it('returns true when bot number without suffix is in mentionedIds', () => {
    const msg = makeMessage({
      text: '@628123456789 hello',
      mentionedIds: ['628123456789'],
    });
    expect(isBotMentioned(msg, BOT_NUMBER)).toBe(true);
  });

  it('returns false when different number is in mentionedIds', () => {
    const msg = makeMessage({
      text: '@6289999999999 hello',
      mentionedIds: ['6289999999999@s.whatsapp.net'],
    });
    expect(isBotMentioned(msg, BOT_NUMBER)).toBe(false);
  });

  it('returns true via text fallback when mentionedIds is empty', () => {
    const msg = makeMessage({
      text: '@628123456789 jelaskan fotosintesis',
      mentionedIds: [],
    });
    expect(isBotMentioned(msg, BOT_NUMBER)).toBe(true);
  });

  it('returns false when no mention at all', () => {
    const msg = makeMessage({
      text: 'halo apa kabar semua?',
      mentionedIds: [],
    });
    expect(isBotMentioned(msg, BOT_NUMBER)).toBe(false);
  });

  it('returns true for @+628xxx format in text', () => {
    const msg = makeMessage({
      text: '@+628123456789 halo',
      mentionedIds: [],
    });
    expect(isBotMentioned(msg, BOT_NUMBER)).toBe(true);
  });
});

describe('stripBotMention', () => {
  it('removes @botNumber from text', () => {
    const result = stripBotMention('@628123456789 jelasin fotosintesis', BOT_NUMBER);
    expect(result).toBe('jelasin fotosintesis');
  });

  it('removes @+botNumber from text', () => {
    const result = stripBotMention('@+628123456789 halo siapa kamu?', BOT_NUMBER);
    expect(result).toBe('halo siapa kamu?');
  });

  it('removes @botNumber@s.whatsapp.net from text', () => {
    const result = stripBotMention('@628123456789@s.whatsapp.net apa itu black hole', BOT_NUMBER);
    expect(result).toBe('apa itu black hole');
  });

  it('handles text without mention gracefully', () => {
    const result = stripBotMention('hello world', BOT_NUMBER);
    expect(result).toBe('hello world');
  });

  it('handles mention at end of text', () => {
    const result = stripBotMention('tolong @628123456789', BOT_NUMBER);
    expect(result).toBe('tolong');
  });

  it('returns empty string for empty input', () => {
    const result = stripBotMention('', BOT_NUMBER);
    expect(result).toBe('');
  });

  it('handles multiple mentions', () => {
    const result = stripBotMention('@628123456789 halo @628123456789', BOT_NUMBER);
    expect(result.trim()).toBe('halo');
  });
});
