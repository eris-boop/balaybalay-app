/**
 * Standalone test script for AI Service & Multi-Model Failover.
 * Usage: npm run test:ai -- "Halo"
 */

import 'dotenv/config';
import path from 'path';
import dotenv from 'dotenv';

// Ensure .env is explicitly loaded from root before any application modules are evaluated
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

function maskApiKey(key: string): string {
  if (!key) return '(not configured)';
  const trimmed = key.trim();
  if (trimmed.length <= 10) return '***';
  const prefix = trimmed.slice(0, 6);
  const suffix = trimmed.slice(-4);
  return `${prefix}***${suffix}`;
}

async function main(): Promise<void> {
  // Dynamically import application config and services after dotenv has completed loading
  const { config } = await import('../src/config');
  const { detectTaskType, getAIDiagnostics, getOpenAIClient } = await import(
    '../src/services/aiService'
  );
  const { generateReply } = await import('../src/services/gemini');


  const userPrompt = process.argv.slice(2).join(' ').trim() || 'Halo';
  const taskType = detectTaskType(userPrompt);
  const providerName = config.aiProvider === 'vpsmurah' ? 'VPSMurah' : 'Google Gemini';
  const primaryModel =
    config.aiProvider === 'vpsmurah'
      ? config.aiGeneralChain[0] || 'gemini-38'
      : config.geminiModel;

  const rawEnvKey = process.env.VPSMURAH_AI_API_KEY || '';
  const client = getOpenAIClient();
  const clientKey = client.apiKey || '';

  console.log(`🤖 [AI TEST] Starting AI connectivity test...`);
  console.log(`Provider: ${providerName}`);
  console.log(`Detected task: ${taskType}`);
  console.log(`Base URL: ${config.vpsmurahAiBaseUrl}`);
  console.log(`API key configured: ${Boolean(rawEnvKey)}`);
  console.log(`API key length: ${rawEnvKey.length}`);
  console.log(`API key masked: ${maskApiKey(rawEnvKey)}`);
  console.log(`Client apiKey masked: ${maskApiKey(clientKey)}`);
  console.log(`Primary model: ${primaryModel}`);
  console.log(`Sending prompt: "${userPrompt}"...\n`);

  try {
    const response = await generateReply({
      message: userPrompt,
      chatId: 'test-cli-chat@s.whatsapp.net',
      history: [],
    });

    const diag = getAIDiagnostics();
    const modelUsed = diag.lastUsedModel || primaryModel;
    const fallbackUsed = modelUsed !== primaryModel;

    console.log(`\n✅ [AI TEST] SUCCESS`);
    console.log(`Provider: ${providerName}`);
    console.log(`Task type: ${diag.lastTaskType || taskType}`);
    console.log(`Primary model: ${primaryModel}`);
    console.log(`Model used: ${modelUsed}`);
    if (fallbackUsed) {
      console.log(`Fallback used: true`);
      console.log(`Fallback count: ${diag.lastFallbackCount}`);
    }
    console.log(`Duration: ${diag.lastAIDurationMs}ms`);
    console.log(`Response: ${response}`);

    process.exitCode = 0;
  } catch (err: any) {
    const rawMsg = err?.message || String(err);
    const sanitizedMsg = rawMsg
      .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [REDACTED]')
      .replace(/key=[^&\s]+/g, 'key=[REDACTED]');

    console.error(`\n❌ [AI TEST] FAILED`);
    console.error(`Provider: ${providerName}`);
    console.error(`Task type: ${taskType}`);
    console.error(`Primary model: ${primaryModel}`);
    console.error(`Error: ${sanitizedMsg}`);

    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exitCode = 1;
});
