/**
 * Mention detection and stripping service.
 * Determines if the bot was mentioned in a group message
 * and cleans the mention from the text before sending to AI.
 * Supports standard @s.whatsapp.net and modern @lid mentioned IDs.
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { IncomingMessage } from '../types/whatsapp';
import { normalizePhone, phoneEquals } from '../utils/phone';

/**
 * Check if the bot is mentioned in the message.
 *
 * Strategy:
 * 1. Check mentionedIds from provider payload (primary).
 *    Supports @s.whatsapp.net and @lid identifiers.
 * 2. Fallback: check if text contains @botNumber / @botId pattern.
 */
export function isBotMentioned(
  message: IncomingMessage,
  botIdentifiers: string | string[]
): boolean {
  const identifiers = (Array.isArray(botIdentifiers) ? botIdentifiers : [botIdentifiers])
    .filter((id): id is string => Boolean(id && id.trim()));

  if (identifiers.length === 0) {
    return false;
  }

  // 1. Primary: check mentionedIds from provider
  if (message.mentionedIds && message.mentionedIds.length > 0) {
    for (const mentioned of message.mentionedIds) {
      const normMentioned = jidNormalizedUser(mentioned).toLowerCase();
      for (const botId of identifiers) {
        const normBotId = jidNormalizedUser(botId).toLowerCase();
        // Exact JID match (supports @lid and @s.whatsapp.net)
        if (normMentioned === normBotId) {
          return true;
        }
        // Phone number normalization match
        if (phoneEquals(mentioned, botId)) {
          return true;
        }
      }
    }
  }

  // 2. Fallback: check text for @mention patterns
  for (const botId of identifiers) {
    if (isTextMention(message.text, botId)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the bot identifier appears as a text mention.
 */
function isTextMention(text: string, botId: string): boolean {
  if (!text || !botId) return false;

  const normalized = normalizePhone(botId);
  const patterns: string[] = [];

  if (normalized) {
    patterns.push(`@${normalized}`);
    patterns.push(`@+${normalized}`);
    if (normalized.startsWith('62')) {
      patterns.push(`@${normalized.replace(/^62/, '0')}`);
    }
  }

  patterns.push(`@${botId}`);

  const lowerText = text.toLowerCase();
  return patterns.some((p) => lowerText.includes(p.toLowerCase()));
}

/**
 * Remove bot mention from the text.
 * Returns the cleaned text ready for AI processing.
 */
export function stripBotMention(text: string, botIdentifiers: string | string[]): string {
  if (!text) return '';

  const identifiers = (Array.isArray(botIdentifiers) ? botIdentifiers : [botIdentifiers])
    .filter((id): id is string => Boolean(id && id.trim()));

  if (identifiers.length === 0) {
    return text;
  }

  let cleaned = text;

  for (const botId of identifiers) {
    const normJid = jidNormalizedUser(botId);
    if (normJid) {
      cleaned = cleaned.replace(new RegExp(`@${normJid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), '');
    }

    const normalized = normalizePhone(botId);
    if (normalized) {
      // Remove @number@s.whatsapp.net and @number@lid patterns
      cleaned = cleaned.replace(new RegExp(`@${normalized}@s\\.whatsapp\\.net`, 'gi'), '');
      cleaned = cleaned.replace(new RegExp(`@${normalized}@lid`, 'gi'), '');
      // Remove @+number patterns
      cleaned = cleaned.replace(new RegExp(`@\\+?${normalized}`, 'gi'), '');

      // Remove @0-prefixed local format (for Indonesian numbers)
      if (normalized.startsWith('62')) {
        const local = normalized.replace(/^62/, '0');
        cleaned = cleaned.replace(new RegExp(`@\\+?${local}`, 'gi'), '');
      }

      // Remove any leftover @number patterns that match suffix
      const lastDigits = normalized.slice(-8);
      if (lastDigits.length >= 8) {
        cleaned = cleaned.replace(new RegExp(`@\\+?\\d*${lastDigits}`, 'g'), '');
      }
    }
  }

  // Clean up extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}
