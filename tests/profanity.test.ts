/**
 * Test Suite for Profanity Filter.
 *
 * Verifies:
 * 1. "anjing" masked -> a****g
 * 2. "ANJING" masked -> A****G
 * 3. "Anjing" masked -> A****g
 * 4. multiple profanity masked in a single sentence
 * 5. custom profanity (PROFANITY_EXTRA_WORDS) works
 * 6. filter disabled (PROFANITY_FILTER_ENABLED=false) works
 * 7. normal Indonesian text unchanged
 * 8. word boundary prevents false positive (kontainer, mementingkan, tolong, pakaian)
 * 9. AI response passes through filter before WhatsApp sendMessage
 * 10. user input remains original before AI
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterProfanity, maskWord } from '../src/services/profanityFilter';
import { config } from '../src/config';
import { processIncomingMessage } from '../src/services/messageProcessor';
import * as whatsappService from '../src/services/whatsapp';
import * as geminiService from '../src/services/gemini';
import { IncomingMessage } from '../src/types/whatsapp';

describe('Profanity Filter Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (config as any).profanityFilterEnabled = true;
    (config as any).profanityFilterMode = 'mask';
    (config as any).profanityExtraWords = '';
  });

  // 1. "anjing" masked
  it('1. masks lowercase "anjing" to "a****g"', () => {
    const result = filterProfanity('dasar anjing kamu');
    expect(result).toBe('dasar a****g kamu');
  });

  // 2. "ANJING" masked
  it('2. masks uppercase "ANJING" to "A****G"', () => {
    const result = filterProfanity('DASAR ANJING!');
    expect(result).toBe('DASAR A****G!');
  });

  // 3. "Anjing" masked
  it('3. masks capitalized "Anjing" to "A****g"', () => {
    const result = filterProfanity('Anjing itu lucu');
    expect(result).toBe('A****g itu lucu');
  });

  // 4. multiple profanity masked
  it('4. masks multiple profanities in a single sentence', () => {
    const input = 'bangsat lu, dasar goblok dan tolol!';
    const result = filterProfanity(input);
    expect(result).toContain('b*****t');
    expect(result).toContain('g****k');
    expect(result).toContain('t***l');
  });

  // 5. custom profanity works
  it('5. masks custom profanity words from config.profanityExtraWords', () => {
    (config as any).profanityExtraWords = 'kampretos,kacauuu';
    const result = filterProfanity('kamu kampretos sekali');
    expect(result).toBe('kamu k*******s sekali');
  });

  // 6. filter disabled works
  it('6. returns unchanged text when profanity filter is disabled', () => {
    (config as any).profanityFilterEnabled = false;
    const text = 'dasar anjing dan bangsat';
    expect(filterProfanity(text)).toBe(text);
  });

  // 7. normal Indonesian text unchanged
  it('7. leaves normal Indonesian sentences completely unchanged', () => {
    const normalText = 'Selamat pagi! Bagaimana cara membuat aplikasi web dengan Node.js dan TypeScript?';
    expect(filterProfanity(normalText)).toBe(normalText);
  });

  // 8. word boundary prevents false positive
  it('8. word boundary prevents false positives on substring matches', () => {
    const safeWords = [
      'kontainer pengiriman barang sudah tiba',
      'pemerintah mementingkan kesejahteraan rakyat',
      'tolong bantu saya menyelesaikan tugas ini',
      'pakaian dinas harian pegawai',
      'bengkel mobil buka setiap hari',
      'asumsi ini berdasarkan data penelitian',
    ];

    for (const text of safeWords) {
      expect(filterProfanity(text)).toBe(text);
    }
  });

  // Also test obfuscation handling: anj1ng, a n j i n g, a.n.j.i.n.g
  it('8b. handles obfuscated profanities safely', () => {
    expect(filterProfanity('dasar anj1ng!')).toBe('dasar a****g!');
    expect(filterProfanity('kamu a.n.j.i.n.g')).toBe('kamu a*********g');
  });

  // Code block protection
  it('8c. preserves words inside markdown code blocks', () => {
    const textWithCode = 'Berikut fungsinya:\n```typescript\nconst anjing = "anjing";\n```\nanjing itu';
    const result = filterProfanity(textWithCode);
    expect(result).toContain('```typescript\nconst anjing = "anjing";\n```');
    expect(result).toContain('a****g itu');
  });

  // 9. AI response passes through filter before WhatsApp sendMessage
  it('9. AI response passes through profanity filter before WhatsApp sendMessage', async () => {
    const sendMessageSpy = vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);
    vi.spyOn(geminiService, 'generateReply').mockResolvedValue('Kamu ini memang anjing dan bangsat');

    const msg: IncomingMessage = {
      chatId: '628111222333@s.whatsapp.net',
      senderId: '628111222333@s.whatsapp.net',
      senderName: 'Budi',
      text: 'siapa saya?',
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: `test-profanity-${Date.now()}`,
      mentionedIds: [],
    };

    await processIncomingMessage(msg);

    expect(sendMessageSpy).toHaveBeenCalled();
    const sentText = sendMessageSpy.mock.calls[0][1];
    expect(sentText).toContain('a****g');
    expect(sentText).toContain('b*****t');
    expect(sentText).not.toContain('anjing');
    expect(sentText).not.toContain('bangsat');
  });

  // 10. user input remains original before AI
  it('10. user prompt remains original and unmasked when passed to AI', async () => {
    let receivedPrompt = '';
    vi.spyOn(geminiService, 'generateReply').mockImplementation(async (opts: geminiService.GenerateReplyParams) => {
      receivedPrompt = opts.message;
      return 'Arti kata tersebut adalah hewan mamalia berkaki empat.';
    });
    vi.spyOn(whatsappService, 'sendMessage').mockResolvedValue(true as any);

    const rawUserPrompt = 'apa arti kata anjing?';
    const msg: IncomingMessage = {
      chatId: '628111222333@s.whatsapp.net',
      senderId: '628111222333@s.whatsapp.net',
      senderName: 'Budi',
      text: rawUserPrompt,
      timestamp: Date.now(),
      isGroup: false,
      isFromMe: false,
      messageType: 'text',
      messageId: `test-user-raw-${Date.now()}`,
      mentionedIds: [],
    };

    await processIncomingMessage(msg);

    // AI must receive the exact original prompt
    expect(receivedPrompt).toBe(rawUserPrompt);
  });
});
