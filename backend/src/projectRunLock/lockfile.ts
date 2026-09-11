import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  };
  return {
    pid: candidate.pid,
    hostname: typeof candidate.hostname === 'string' ? candidate.hostname : '?',
    startedAt: typeof candidate.startedAt === 'number' ? candidate.startedAt : 0,
    label: typeof candidate.label === 'string' ? candidate.label : '?',
  };
}

export async function readLockBody(file: string): Promise<LockBody | null> {
  try {
    return parseLockBody(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
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

export async function deleteLockFile(file: string): Promise<void> {
  await fs.unlink(file).catch(() => undefined);
}

export function sameLockBody(a: LockBody, b: LockBody): boolean {
  return (
    a.pid === b.pid &&
    a.hostname === b.hostname &&
    a.startedAt === b.startedAt &&
    a.label === b.label
  );
}
