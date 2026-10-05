/**
 * Knowledge Text Snapshot Service.
 *
 * Generates human-readable projections of active memory facts:
 * 1. knowledge_snapshot.txt: Full active fact list.
 * 2. new_information.txt: Recently learned facts with timestamps.
 *
 * Uses atomic writes (write temp file -> rename) to prevent corruption.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getAllActiveFacts } from '../database/factsRepository';
import { logger } from '../utils/logger';

let lastTextSnapshotAt: string | null = null;

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Export human-readable knowledge snapshot atomically.
 */
export async function exportKnowledgeTextSnapshot(): Promise<void> {
  if (!config.memoryTextSnapshotEnabled) return;

  try {
    const activeFacts = await getAllActiveFacts();
    const snapshotPath = path.resolve(config.memoryTextSnapshotPath);
    ensureDir(snapshotPath);

    const now = new Date().toISOString();
    let content = `=== BALAYBALAY GLOBAL KNOWLEDGE ===\n\n`;

    if (activeFacts.length === 0) {
      content += `(Belum ada fakta pengetahuan yang tersimpan)\n`;
    } else {
      for (const fact of activeFacts) {
        content += `- ${fact.factText}\n`;
      }
    }

    content += `\nGenerated: ${now}\n`;
    content += `Active Facts: ${activeFacts.length}\n`;

    // Atomic write
    const tempPath = `${snapshotPath}.tmp_${Date.now()}`;
    await fs.promises.writeFile(tempPath, content, 'utf-8');
    await fs.promises.rename(tempPath, snapshotPath);

    lastTextSnapshotAt = now;
    logger.memory.info(`[memory] knowledge text snapshot refreshed (${activeFacts.length} facts)`);
  } catch (err) {
    logger.memory.warn('Failed to export knowledge text snapshot:', (err as Error).message);
  }
}

/**
 * Append a newly learned fact to the new_information.txt log.
 */
export async function recordNewInformationFact(factText: string): Promise<void> {
  if (!config.memoryTextSnapshotEnabled || !factText) return;

  try {
    const newInfoPath = path.resolve(config.memoryNewInfoSnapshotPath);
    ensureDir(newInfoPath);

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
    const line = `[${timestamp}] NEW: ${factText.trim()}\n`;

    await fs.promises.appendFile(newInfoPath, line, 'utf-8');
  } catch (err) {
    logger.memory.warn('Failed to append to new_information.txt:', (err as Error).message);
  }
}

/**
 * Diagnostics accessor for snapshot timestamp.
 */
export function getLastTextSnapshotAt(): string | null {
  return lastTextSnapshotAt;
}

/**
 * Reset snapshot diagnostics for tests.
 */
export function resetSnapshotDiagnosticsForTest(): void {
  lastTextSnapshotAt = null;
}
