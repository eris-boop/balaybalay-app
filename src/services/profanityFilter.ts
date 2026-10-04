/**
 * Profanity Filter Service for Bot Outputs.
 *
 * Requirements:
 * - Bot receives and understands raw user prompt (never masked before AI).
 * - Bot output to WhatsApp is passed through profanity filter.
 * - Mask format: first character + stars (*) + last character.
 *   - length <= 2: first char + '*' (or first char only if length=1).
 *   - length >= 3: firstChar + '*'.repeat(length - 2) + lastChar.
 * - Case-preservation: ANJING -> A****G, Anjing -> A****g, anjing -> a****g.
 * - Word-boundary aware: NEVER mask substrings in normal words (kontainer, mementingkan, tolong, etc.).
 * - Obfuscation handling: a.n.j.i.n.g, a n j i n g, anj1ng, anj!ng.
 * - Preserves Markdown code blocks (```code``` and `inline code`).
 * - Configurable via PROFANITY_FILTER_ENABLED, PROFANITY_FILTER_MODE, PROFANITY_EXTRA_WORDS.
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// Default built-in list of Indonesian & common harsh words (in lowercase base form)
const DEFAULT_PROFANITY_WORDS: string[] = [
  'anjing',
  'bangsat',
  'goblok',
  'kontol',
  'memek',
  'ngentot',
  'brengsek',
  'jancuk',
  'tolol',
  'idiot',
  'babi',
  'bajingan',
  'pantek',
  'itil',
  'peli',
  'jembut',
  'kampret',
  'asu',
  'tai',
  'pecun',
  'lonte',
  'kimak',
  'puki',
  'tetek',
  'titit',
  'perek',
  'fuck',
  'bitch',
  'shit',
  'asshole',
  'cunt',
  'dick',
];

// Leetspeak normalization map for detection
const LEET_MAP: Record<string, string> = {
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '0': 'o',
  '3': 'e',
  '@': 'a',
  '4': 'a',
  '5': 's',
  '$': 's',
  '7': 't',
};

/**
 * Helper to mask a raw matched word string preserving its length and casing of first and last chars.
 */
export function maskWord(word: string): string {
  const len = word.length;
  if (len <= 1) return word;
  if (len === 2) {
    return word[0] + '*';
  }
  const first = word[0];
  const last = word[len - 1];
  const middle = '*'.repeat(len - 2);
  return `${first}${middle}${last}`;
}

/**
 * Normalize an obfuscated token (e.g. "a.n.j.i.n.g", "a n j i n g", "anj1ng") to plain characters.
 */
function normalizeToken(raw: string): string {
  let normalized = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i].toLowerCase();
    // Skip separator dots, dashes, underscores, spaces inside obfuscated token
    if (char === '.' || char === '-' || char === '_' || char === ' ') {
      continue;
    }
    normalized += LEET_MAP[char] || char;
  }
  return normalized;
}

/**
 * Get active list of profanity words (built-in + extra configured).
 */
export function getProfanityList(): string[] {
  const extraWords = (config.profanityExtraWords || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);

  const set = new Set<string>([...DEFAULT_PROFANITY_WORDS, ...extraWords]);
  return Array.from(set);
}

/**
 * Filter profanity from natural language text.
 */
export function filterProfanityText(text: string): string {
  if (!text || typeof text !== 'string') return text;

  const profanityWords = getProfanityList();
  if (profanityWords.length === 0) return text;

  // Build a lookup set for quick matching
  const profanitySet = new Set(profanityWords);

  // 1. Regex to match potential words / spaced tokens:
  // Matches normal words, leetspeak words (letters, numbers, symbols like !),
  // or single characters separated by dots/spaces/dashes (e.g. a.n.j.i.n.g or a n j i n g)
  const tokenRegex = /(?:\b[a-zA-Z0-9!@$|]{2,}\b|(?:[a-zA-Z][\s.\-_]){2,}[a-zA-Z])/g;

  return text.replace(tokenRegex, (match) => {
    const normalized = normalizeToken(match);

    // Exact check on normalized word
    if (profanitySet.has(normalized)) {
      return maskWord(match);
    }

    return match;
  });
}

/**
 * Filter profanity in AI response, protecting Markdown code blocks.
 *
 * If AI output includes:
 * ```code
 * ...
 * ```
 * or `inline code`
 * we preserve the code content and only mask the surrounding natural language.
 */
export function filterProfanity(text: string): string {
  if (!config.profanityFilterEnabled) {
    return text;
  }

  if (!text || typeof text !== 'string') {
    return text;
  }

  try {
    // Split into code blocks and normal text blocks
    // Captures: ```...``` or `...`
    const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

    const filteredParts = parts.map((part) => {
      // If it's a code block (starts with ``` or `), keep it intact
      if (part.startsWith('```') || (part.startsWith('`') && part.endsWith('`'))) {
        return part;
      }
      return filterProfanityText(part);
    });

    return filteredParts.join('');
  } catch (err) {
    logger.profanity.error('Failed to filter profanity, falling back to raw text:', (err as Error).message);
    return text;
  }
}

export const profanityFilter = {
  mask: filterProfanity,
  filterProfanity,
  maskWord,
  getProfanityList,
};
