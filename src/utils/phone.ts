/**
 * Phone number and WhatsApp JID normalization utilities.
 * Supports modern WhatsApp JIDs (@s.whatsapp.net, @lid, @g.us).
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';

/**
 * Extract raw digits from a WhatsApp ID / phone string.
 * Strips: leading +, trailing @s.whatsapp.net / @c.us / @lid / @g.us, all non-digit chars.
 */
export function normalizePhone(input: string): string {
  if (!input) return '';

  let cleaned = input.trim();

  // Remove WhatsApp suffixes
  cleaned = cleaned
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@c\.us$/i, '')
    .replace(/@lid$/i, '')
    .replace(/@g\.us$/i, '');

  // Remove leading +
  cleaned = cleaned.replace(/^\+/, '');

  // Keep only digits
  cleaned = cleaned.replace(/\D/g, '');

  return cleaned;
}

/**
 * Compare two phone numbers / WhatsApp IDs for equality after normalization.
 */
export function phoneEquals(a: string, b: string): boolean {
  if (!a || !b) return false;

  // Direct normalized JID match (supports exact @lid and @s.whatsapp.net)
  const normA = jidNormalizedUser(a);
  const normB = jidNormalizedUser(b);
  if (normA && normB && normA.toLowerCase() === normB.toLowerCase()) {
    return true;
  }

  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;

  // Only compare digits if both are reasonable phone lengths (>= 8 digits)
  if (na === nb) return true;
  if (na.length >= 8 && nb.length >= 8) {
    return na.endsWith(nb) || nb.endsWith(na);
  }

  return false;
}

/**
 * Check if a given chatId represents a group chat (@g.us).
 */
export function isGroupChat(chatId: string): boolean {
  if (!chatId) return false;
  return chatId.includes('@g.us');
}

/**
 * Check if a given chatId represents a private chat (@s.whatsapp.net or @lid).
 */
export function isPrivateChat(chatId: string): boolean {
  if (!chatId) return false;
  return chatId.includes('@s.whatsapp.net') || chatId.includes('@lid');
}

/**
 * Format recipient destination for sending WhatsApp messages.
 * - Group chats (e.g. 120363001234567890@g.us): preserve group ID without alteration.
 * - Private chats (@lid or @s.whatsapp.net): preserve if JID, otherwise digits only.
 */
export function formatRecipient(chatId: string): string {
  if (!chatId) return '';
  const trimmed = chatId.trim();

  if (isGroupChat(trimmed)) {
    return trimmed;
  }

  return normalizePhone(trimmed);
}

/**
 * Format chatId into a valid Baileys JID.
 * Preserves EXACT JIDs for:
 * - Group: ...@g.us
 * - Modern Private LID: ...@lid
 * - Standard Private: ...@s.whatsapp.net
 * If raw phone number provided without domain, appends @s.whatsapp.net.
 */
export function toBaileysJid(chatId: string): string {
  if (!chatId) return '';
  const trimmed = chatId.trim();

  if (
    trimmed.endsWith('@g.us') ||
    trimmed.endsWith('@lid') ||
    trimmed.endsWith('@s.whatsapp.net')
  ) {
    return jidNormalizedUser(trimmed);
  }

  const digits = normalizePhone(trimmed);
  return digits ? `${digits}@s.whatsapp.net` : '';
}
