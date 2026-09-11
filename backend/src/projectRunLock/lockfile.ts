import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { LockBody } from './types.js';

export function parseLockBody(raw: string): LockBody | null {
  const body: unknown = JSON.parse(raw);
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { pid?: unknown }).pid !== 'number'
  ) {
    return null;
  }

  const candidate = body as {
    pid: number;
    hostname?: unknown;
    startedAt?: unknown;
    label?: unknown;
    ownerId?: unknown;
  };
  return {
    pid: candidate.pid,
    hostname: typeof candidate.hostname === 'string' ? candidate.hostname : '?',
    startedAt: typeof candidate.startedAt === 'number' ? candidate.startedAt : 0,
    label: typeof candidate.label === 'string' ? candidate.label : '?',
    ...(typeof candidate.ownerId === 'string' ? { ownerId: candidate.ownerId } : {}),
  };
}

export async function readLockBody(file: string): Promise<LockBody | null> {
  try {
    return parseLockBody(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export type LockObservation = { raw: string; body: LockBody | null };

export async function readLockObservation(file: string): Promise<LockObservation | null> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err; // Unreadable is not proof of abandonment.
  }
  let body: LockBody | null;
  try { body = parseLockBody(raw); } catch { body = null; }
  return { raw, body };
}

export async function writeNewLockBody(
  file: string,
  body: LockBody,
): Promise<void> {
  // A wx write publishes an EMPTY file before the async body write finishes.
  // A contender can mistake that partial body for a corrupt stale lock and
  // unlink it, letting both owners enter. Publish a fully written inode with
  // an atomic exclusive hard link; unlike rename this never replaces a lock.
  const pending = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(pending, JSON.stringify(body, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.link(pending, file);
  } finally {
    await fs.unlink(pending).catch(() => undefined);
  }
}

// Exactly ONE process may unlink each observed generation. This permanent
// tombstone is a filesystem CAS substitute: another observer of the old body
// cannot remove the next owner's file, even after its PID check was suspended.
// Never delete tombstones while contenders could retain old observations.
export async function retireLockFile(file: string, observed: LockObservation): Promise<boolean> {
  const retirementDir = `${file}.retired`;
  await fs.mkdir(retirementDir, { recursive: true });
  const generation = createHash('sha256').update(observed.raw).digest('hex');
  const retirement = `${retirementDir}/${generation}`;
  try {
    await fs.writeFile(retirement, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  const current = await readLockObservation(file);
  if (!current || current.raw !== observed.raw) return false;
  // There is no await between a later ownership observation and another actor
  // replacing this generation: replacement requires OUR unlink first. A crash
  // before unlink leaves a blocked retirement, which is refused on next boot.
  await fs.unlink(file);
  return true;
}

export function sameLockBody(a: LockBody, b: LockBody): boolean {
  return (
    a.pid === b.pid &&
    a.hostname === b.hostname &&
    a.startedAt === b.startedAt &&
    a.label === b.label &&
    a.ownerId === b.ownerId
  );
}
