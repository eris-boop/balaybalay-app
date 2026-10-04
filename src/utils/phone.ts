/**
 * Phone number normalization utilities.
 * Ensures consistent comparison regardless of format variations
 * like +628xxx, 628xxx, 628xxx@s.whatsapp.net, 628xxx@c.us, etc.
 */

/**
 * Extract raw digits from a WhatsApp ID / phone string.
 * Strips: leading +, trailing @s.whatsapp.net / @c.us, all non-digit chars.
 */
export function normalizePhone(input: string): string {
  if (!input) return '';

  let cleaned = input.trim();

  // Remove WhatsApp suffixes
  cleaned = cleaned
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@c\.us$/i, '')
    .replace(/@g\.us$/i, '');  // group IDs

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
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

/**
 * Check if a given chatId represents a group chat.
 * VPSMurah / Baileys typically uses @g.us suffix for groups.
 */
export function isGroupChat(chatId: string): boolean {
  return chatId.includes('@g.us');
}
