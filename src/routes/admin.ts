/**
 * Admin routes protected by ADMIN_TOKEN.
 * Exposes secure QR pairing interface for WhatsApp Web login.
 */

import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { config } from '../config';
import { getWhatsAppStatus, getLatestQr, getDiagnostics } from '../services/whatsappClient';
import { getAIDiagnostics } from '../services/aiService';

export const adminRouter = Router();

/**
 * Middleware: Verify ADMIN_TOKEN.
 * Accepts token via ?token= query parameter or x-admin-token header or Bearer token.
 */
function verifyAdminToken(req: Request, res: Response, next: () => void): void {
  // If ADMIN_TOKEN is not set in config, deny all access for safety
  if (!config.adminToken) {
    res.status(403).json({
      error: 'ADMIN_TOKEN is not configured on the server. Please set ADMIN_TOKEN in environment variables.',
    });
    return;
  }

  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const headerToken = req.headers['x-admin-token'] as string | undefined;
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;

  const providedToken = queryToken || headerToken || bearerToken;

  if (!providedToken || providedToken !== config.adminToken) {
    res.status(403).json({ error: 'Forbidden: invalid or missing admin token' });
    return;
  }

  next();
}

/**
 * GET /admin/qr
 * Displays WhatsApp QR code for pairing if not connected.
 * Returns { connected: true } if already connected.
 */
adminRouter.get('/qr', verifyAdminToken, async (req: Request, res: Response) => {
  const status = getWhatsAppStatus();

  // If already connected, return JSON response
  if (status.connected) {
    res.status(200).json({ connected: true });
    return;
  }

  const qr = getLatestQr();

  if (!qr) {
    // QR code is not ready yet; send a simple auto-refreshing status page
    const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3">
  <title>WhatsApp Pairing - Menghubungkan...</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; text-align: center; }
    .card { background: #1e293b; padding: 2rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 400px; }
    .spinner { border: 4px solid rgba(255,255,255,0.1); width: 40px; height: 40px; border-radius: 50%; border-left-color: #22c55e; animation: spin 1s linear infinite; margin: 1.5rem auto; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h2>Menghubungkan ke WhatsApp...</h2>
    <div class="spinner"></div>
    <p>Sedang mempersiapkan QR code pairing. Halaman akan me-refresh otomatis setiap 3 detik.</p>
  </div>
</body>
</html>`;
    res.status(200).type('html').send(html);
    return;
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="20">
  <title>WhatsApp Web QR Pairing</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; text-align: center; }
    .card { background: #111b21; padding: 2.5rem; border-radius: 16px; border: 1px solid #222e35; max-width: 420px; box-shadow: 0 12px 30px rgba(0,0,0,0.6); }
    h2 { margin-top: 0; color: #25d366; }
    p { color: #8696a0; font-size: 0.95rem; line-height: 1.5; }
    img { border-radius: 12px; background: white; padding: 12px; margin: 1rem 0; width: 280px; height: 280px; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; background: rgba(37, 211, 102, 0.15); color: #25d366; font-size: 0.8rem; font-weight: 600; margin-bottom: 1rem; }
    .footer { font-size: 0.8rem; color: #667781; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">WHATSAPP WEB PAIRING</div>
    <h2>Scan QR Code</h2>
    <p>Buka WhatsApp di HP Anda &gt; Pengaturan &gt; <strong>Perangkat Tertaut (Linked Devices)</strong> &gt; Tautkan Perangkat.</p>
    <img src="${qrDataUrl}" alt="WhatsApp QR Code" />
    <p class="footer">QR code diperbarui otomatis. Halaman me-refresh setiap 20 detik.</p>
  </div>
</body>
</html>`;

    res.status(200).type('html').send(html);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR image' });
  }
});

import { isDatabaseConnected, getDatabaseHealth, query, getDbPool } from '../database/db';
import { memory, getMemoryDiagnostics } from '../services/memory';
import { getLearnerDiagnostics } from '../services/memoryLearner';
import { getActiveFactCount, refreshActiveFactCount } from '../database/factsRepository';
import { getLastTextSnapshotAt } from '../services/knowledgeSnapshot';
import { getSpoolPendingCount } from '../services/dbSpool';

/**
 * GET /admin/status
 * Returns sanitized diagnostics data (protected by ADMIN_TOKEN).
 */
adminRouter.get('/status', verifyAdminToken, (_req: Request, res: Response) => {
  const diag = getDiagnostics();
  const aiDiag = getAIDiagnostics();
  const dbHealth = getDatabaseHealth();
  const memDiag = getMemoryDiagnostics();
  const learnerDiag = getLearnerDiagnostics();
  const factCount = getActiveFactCount();
  const spoolPending = getSpoolPendingCount();
  const lastSnapshotAt = getLastTextSnapshotAt();

  res.status(200).json({
    ...diag,
    ...aiDiag,
    databaseConnected: dbHealth.status === 'healthy',
    databaseHealth: dbHealth.status,
    dbPoolTotal: dbHealth.poolTotal,
    dbPoolIdle: dbHealth.poolIdle,
    dbPoolWaiting: dbHealth.poolWaiting,
    persistentMemory: dbHealth.status === 'healthy',
    memorySummaryEnabled: config.memorySummaryEnabled,
    memoryRetrievalEnabled: config.memoryRetrievalEnabled,
    globalMemoryEnabled: config.globalMemoryEnabled,
    globalMemoryScope: config.globalMemoryScope,
    globalMemoryCrossChat: config.globalMemoryCrossChat,
    lastMemoryLoadAt: memDiag.lastMemoryLoadAt,
    lastMemorySaveAt: memDiag.lastMemorySaveAt,
    lastMemoryChatFound: memDiag.lastMemoryChatFound,
    lastMemoryRecentCount: memDiag.lastMemoryRecentCount,
    lastMemoryRelevantCount: memDiag.lastMemoryRelevantCount,
    lastMemorySummaryUsed: memDiag.lastMemorySummaryUsed,
    lastGlobalMemoryCount: memDiag.lastGlobalMemoryCount,
    lastGlobalMemorySummaryUsed: memDiag.lastGlobalMemorySummaryUsed,
    ...learnerDiag,
    knowledgeFactCount: factCount,
    textSnapshotEnabled: config.memoryTextSnapshotEnabled,
    lastTextSnapshotAt: lastSnapshotAt,
    dbSpoolPending: spoolPending,
  });
});

/**
 * GET /admin/memory/stats
 * Returns safe aggregate statistics without any private message contents (protected by ADMIN_TOKEN).
 */
adminRouter.get('/memory/stats', verifyAdminToken, async (_req: Request, res: Response) => {
  let messagesTotal = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let globalSummaryExists = false;

  if (getDbPool()) {
    try {
      const totRes = await query<{ count: string }>('SELECT COUNT(*) as count FROM messages;');
      messagesTotal = parseInt(totRes.rows[0].count, 10) || 0;

      const userRes = await query<{ count: string }>("SELECT COUNT(*) as count FROM messages WHERE role = 'user';");
      userMessages = parseInt(userRes.rows[0].count, 10) || 0;

      const asstRes = await query<{ count: string }>("SELECT COUNT(*) as count FROM messages WHERE role = 'assistant';");
      assistantMessages = parseInt(asstRes.rows[0].count, 10) || 0;

      const globRes = await query<{ count: string }>('SELECT COUNT(*) as count FROM global_memory WHERE summary IS NOT NULL AND length(summary) > 0;');
      globalSummaryExists = (parseInt(globRes.rows[0].count, 10) || 0) > 0;
    } catch {
      // In-memory fallback
    }
  }

  await refreshActiveFactCount();
  const factCount = getActiveFactCount();
  const learnerDiag = getLearnerDiagnostics();
  const spoolPending = getSpoolPendingCount();

  res.status(200).json({
    messagesTotal,
    userMessages,
    assistantMessages,
    activeFacts: factCount,
    pendingLearningJobs: learnerDiag.memoryLearnerPending,
    failedLearningJobs: learnerDiag.memoryLearnerFailed,
    globalSummaryExists,
    dbSpoolPending: spoolPending,
  });
});

/**
 * DELETE /admin/memory/:chatId
 * Delete a specific conversation's history and memories (protected by ADMIN_TOKEN).
 */
adminRouter.delete('/memory/:chatId', verifyAdminToken, async (req: Request, res: Response) => {
  const rawChatId = req.params.chatId;
  const chatId = Array.isArray(rawChatId) ? rawChatId[0] : rawChatId;
  if (!chatId) {
    res.status(400).json({ error: 'chatId parameter is required' });
    return;
  }

  const deleted = await memory.deleteConversation(chatId);
  if (deleted) {
    res.status(200).json({ deleted: true });
  } else {
    res.status(200).json({ deleted: false, reason: 'not_found' });
  }
});

/**
 * DELETE /admin/memory
 * Delete all conversation history and memories across all chats (protected by ADMIN_TOKEN).
 * Requires explicit body confirmation: { "confirm": "DELETE_ALL_MEMORY" }
 */
adminRouter.delete('/memory', verifyAdminToken, async (req: Request, res: Response) => {
  if (req.body?.confirm !== 'DELETE_ALL_MEMORY') {
    res.status(400).json({
      error: 'Confirmation required. Must send JSON body with { "confirm": "DELETE_ALL_MEMORY" }',
    });
    return;
  }

  memory.clearAll();
  res.status(200).json({ deleted: true, all: true });
});
