/**
 * Mention detection and stripping service.
 * Determines if the bot was mentioned in a group message
 * and cleans the mention from the text before sending to AI.
 */

import { IncomingMessage } from '../types/whatsapp';
import { normalizePhone, phoneEquals } from '../utils/phone';

/**
 * Check if the bot is mentioned in the message.
 *
 * Strategy:
 * 1. Check mentionedIds from provider payload (primary).
 * 2. Fallback: check if text contains @botNumber pattern.
 */
export function isBotMentioned(message: IncomingMessage, botNumber: string): boolean {
  const normalizedBot = normalizePhone(botNumber);

  // Primary: check mentionedIds from provider
  if (message.mentionedIds.length > 0) {
    for (const id of message.mentionedIds) {
      if (phoneEquals(id, normalizedBot)) {
        return true;
      }
    }
  }

  // Fallback: check text for @mention patterns
  return isTextMention(message.text, botNumber);
}

/**
 * Check if the bot number appears as a text mention.
 */
function isTextMention(text: string, botNumber: string): boolean {
  if (!text) return false;

  const normalized = normalizePhone(botNumber);
  if (!normalized) return false;

  // Match patterns like @628xxx, @+628xxx
  // The @ symbol followed by digits that match the bot number
  const patterns = [
    `@${normalized}`,
    `@+${normalized}`,
    `@${normalized.replace(/^62/, '0')}`,  // Indonesian local format
  ];

  const lowerText = text.toLowerCase();
  return patterns.some((p) => lowerText.includes(p.toLowerCase()));
}

/**
 * Remove bot mention from the text.
 * Returns the cleaned text ready for AI processing.
 */
export function stripBotMention(text: string, botNumber: string): string {
  if (!text) return '';

  const normalized = normalizePhone(botNumber);
  if (!normalized) return text;

  let cleaned = text;

  // Remove @number@s.whatsapp.net patterns
  cleaned = cleaned.replace(new RegExp(`@${normalized}@s\\.whatsapp\\.net`, 'gi'), '');

  // Remove @+number patterns
  cleaned = cleaned.replace(new RegExp(`@\\+?${normalized}`, 'gi'), '');

  // Remove @0-prefixed local format (for Indonesian numbers)
  if (normalized.startsWith('62')) {
    const local = normalized.replace(/^62/, '0');
    cleaned = cleaned.replace(new RegExp(`@\\+?${local}`, 'gi'), '');
  }

  // Remove any leftover @number patterns that partially match
  // (e.g., provider might send a slightly different format)
  const lastDigits = normalized.slice(-8);
  cleaned = cleaned.replace(new RegExp(`@\\+?\\d*${lastDigits}`, 'g'), '');

  // Clean up extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}
