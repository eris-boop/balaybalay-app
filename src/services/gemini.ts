/**
 * Gemini AI service.
 * Generates responses using Google's Gemini API via the official SDK.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { ConversationEntry } from '../types/whatsapp';
import { logger } from '../utils/logger';

const genai = new GoogleGenAI({ apiKey: config.geminiApiKey });

interface GenerateReplyParams {
  message: string;
  senderName?: string;
  chatId: string;
  history: ConversationEntry[];
}

/**
 * Generate a reply using Gemini.
 */
export async function generateReply(params: GenerateReplyParams): Promise<string> {
  const { message, senderName, chatId, history } = params;

  // Truncate input
  const truncatedMessage = message.substring(0, config.maxInputChars);

  // Build conversation contents for the API
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  // Add history (limited to maxHistoryMessages pairs)
  const maxPairs = config.maxHistoryMessages;
  const recentHistory = history.slice(-(maxPairs * 2));

  for (const entry of recentHistory) {
    contents.push({
      role: entry.role === 'user' ? 'user' : 'model',
      parts: [{ text: entry.content }],
    });
  }

  // Add current message
  let currentPrompt = truncatedMessage;
  if (senderName) {
    currentPrompt = `[${senderName}]: ${truncatedMessage}`;
  }

  contents.push({
    role: 'user',
    parts: [{ text: currentPrompt }],
  });

  try {
    logger.gemini.info('Generating response');

    const response = await genai.models.generateContent({
      model: config.geminiModel,
      contents,
      config: {
        systemInstruction: config.systemPrompt,
        maxOutputTokens: 2048,
        temperature: 0.7,
        topP: 0.9,
      },
    });

    const text = response.text;

    if (!text) {
      logger.gemini.warn('Gemini returned empty response');
      return 'Maaf, saya tidak bisa menghasilkan jawaban saat ini. Coba lagi ya.';
    }

    logger.gemini.info(`Reply generated: ${text.length} chars`);
    return text.trim();
  } catch (err) {
    const error = err as Error;
    logger.gemini.error(`Gemini API error: ${error.message}`);

    // Check for specific error types
    if (error.message?.includes('SAFETY')) {
      return 'Maaf, saya tidak bisa menjawab pertanyaan itu karena alasan keamanan konten.';
    }
    if (error.message?.includes('RATE_LIMIT') || error.message?.includes('429')) {
      return 'Maaf, saya sedang menerima terlalu banyak permintaan. Coba lagi nanti ya.';
    }

    return 'Maaf, saya lagi mengalami gangguan sebentar. Coba lagi ya.';
  }
}
