/**
 * Simple test script for Google Gemini API.
 * Run manually via `npm run test:gemini`.
 * Does NOT run automatically on app startup.
 * Never logs API keys.
 */

import path from 'path';
import dotenv from 'dotenv';

// Explicitly load .env with override: true so local .env values take precedence
dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  override: true,
});

import { GoogleGenAI } from '@google/genai';

async function runGeminiTest(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const rawModel = process.env.GEMINI_MODEL?.trim();
  const model = rawModel && rawModel !== '' ? rawModel : 'gemini-3.7-flash';

  if (!apiKey) {
    console.error('❌ [GEMINI TEST] FAILED: GEMINI_API_KEY is not set in environment or .env file.');
    console.error('   Please obtain a valid API key from Google AI Studio (https://aistudio.google.com/).');
    process.exitCode = 1;
    return;
  }

  console.log('🤖 [GEMINI TEST] Starting Google Gemini connectivity test...');
  console.log(`   Model: ${model}`);
  console.log(`   API Key: [CONFIGURED - REDACTED]`);

  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const genai = new GoogleGenAI({ apiKey });
      console.log('   Sending prompt: "Balas tepat dengan GEMINI_OK"...');

      const response = await genai.models.generateContent({
        model,
        contents: 'Balas tepat dengan GEMINI_OK',
      });

      const text = response.text?.trim() || '';
      console.log(`   Received response: "${text}"`);

      if (text.includes('GEMINI_OK')) {
        console.log('✅ [GEMINI TEST] SUCCESS: Gemini API responded correctly!');
        process.exitCode = 0;
        return;
      } else {
        console.log('⚠️ [GEMINI TEST] SUCCESS (Connected): Gemini responded, but output did not contain exact text:');
        console.log(`   Output: ${text}`);
        process.exitCode = 0;
        return;
      }
    } catch (err) {
      const error = err as Error;
      const isTransient = error.message?.includes('503') || error.message?.includes('429');
      if (isTransient && attempt <= maxRetries) {
        console.warn(`   Notice: Model returned transient status. Retrying in 2s (attempt ${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.error('❌ [GEMINI TEST] FAILED with error:');
      console.error(`   ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
}

// Execute cleanly without force-killing process while handles are closing
void runGeminiTest();
