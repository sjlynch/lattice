import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { canonicalProjectPath, homeProjectScratchDir } from '../projectPath.js';

export const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 3;
export type RecoveryAttempt = { operation: string; checkpoint: string; attempts: number; updatedAt: number; paused?: string };
export function recoveryAttemptsFile(project: string): string { return homeProjectScratchDir(project, 'recovery-attempts.json'); }

export async function readRecoveryAttempts(project: string): Promise<RecoveryAttempt[]> {
  let raw: string;
  try { raw = await fs.readFile(recoveryAttemptsFile(project), 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
  const data = JSON.parse(raw) as { version?: unknown; attempts?: unknown };
  if (data.version !== 1 || !Array.isArray(data.attempts) || !data.attempts.every((r: RecoveryAttempt) =>
    r && typeof r.operation === 'string' && typeof r.checkpoint === 'string' && Number.isSafeInteger(r.attempts) &&
    r.attempts >= 0 && Number.isFinite(r.updatedAt) && (r.paused === undefined || typeof r.paused === 'string'))) {
    throw new Error('Recovery attempt journal is invalid; preserving it and refusing automatic replay');
  }
  return data.attempts;
}

const writes = new Map<string, Promise<unknown>>();
function serialized<T>(project: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalProjectPath(project);
  const work = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  const settled = work.catch(() => {});
  writes.set(key, settled);
  void settled.finally(() => { if (writes.get(key) === settled) writes.delete(key); });
  return work;
}

async function write(project: string, attempts: RecoveryAttempt[]): Promise<void> {
  const file = recoveryAttemptsFile(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify({ version: 1, attempts: attempts.slice(-128) }, null, 2));
}

// Charge before replay so a process-killing failure still consumes its attempt.
// A changed checkpoint is evidence of progress and starts a fresh allowance.
export function claimRecoveryAttempt(project: string, operation: string, checkpoint: string): Promise<RecoveryAttempt> {
  return serialized(project, async () => {
    const records = await readRecoveryAttempts(project);
    const prior = records.find((r) => r.operation === operation && r.checkpoint === checkpoint);
    const attempts = prior?.attempts ?? 0;
    const record: RecoveryAttempt = { operation, checkpoint, attempts: Math.min(attempts + 1, MAX_AUTOMATIC_RECOVERY_ATTEMPTS), updatedAt: Date.now() };
    if (attempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      record.paused = `Automatic recovery paused after ${attempts} interrupted attempts without progress. Work is preserved; inspect the error and retry manually.`;
    }
    await write(project, [...records.filter((r) => r.operation !== operation), record]);
    return record;
  });
}

export function resetRecoveryAttempt(project: string, operation: string): Promise<void> {
  return serialized(project, async () => {
    const records = await readRecoveryAttempts(project);
    if (records.some((r) => r.operation === operation)) await write(project, records.filter((r) => r.operation !== operation));
  });
}
