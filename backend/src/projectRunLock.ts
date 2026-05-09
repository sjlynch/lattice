// Cross-process exclusion for repo-mutating runs (merge-all, manual
// /merge). The in-process guards in mergeRuns.ts and mergeLocks.ts only
// prevent races within a single Lattice process — but Lattice can be
// running on the same project in two places at once (the prototypical
// case: Lattice opened on its own repo, while another Lattice instance
// has the same repo as a project). Both processes can otherwise enter
// the merge pipeline concurrently and race on `git status` / snapshot /
// FF, with destructive results.
//
// Mechanism: a lockfile at `~/.lattice/per-project/<hash>/run.lock`
// holding `{pid, hostname, startedAt, label}`. Created with `wx` (atomic
// fail-if-exists). On contention we read the existing file and, if the
// owner PID is alive, refuse. If the owner is dead (server crashed mid-
// run), we steal the lock — same behaviour as snapshot recovery: assume
// a previous run died and the next one should proceed.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { projectHash } from './projectPath.js';

const LATTICE_HOME = path.join(os.homedir(), '.lattice');

function lockFilePath(projectPath: string): string {
  return path.join(LATTICE_HOME, 'per-project', projectHash(projectPath), 'run.lock');
}

type LockBody = {
  pid: number;
  hostname: string;
  startedAt: number;
  label: string;
};

export class ProjectRunLockedError extends Error {
  readonly holder: LockBody;
  constructor(holder: LockBody) {
    super(
      `Project run lock held by another process ` +
        `(pid=${holder.pid} on ${holder.hostname}, started ` +
        `${new Date(holder.startedAt).toISOString()}, label=${holder.label}).`,
    );
    this.name = 'ProjectRunLockedError';
    this.holder = holder;
  }
}

// `process.kill(pid, 0)` doesn't actually kill — it just probes. ESRCH
// means the PID is gone. EPERM means alive but we can't signal it (still
// "held"). Anything else also treats as alive (fail safe).
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readLockBody(file: string): Promise<LockBody | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const body = JSON.parse(raw);
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof body.pid !== 'number'
    ) {
      return null;
    }
    return {
      pid: body.pid,
      hostname: typeof body.hostname === 'string' ? body.hostname : '?',
      startedAt: typeof body.startedAt === 'number' ? body.startedAt : 0,
      label: typeof body.label === 'string' ? body.label : '?',
    };
  } catch {
    return null;
  }
}

export type ProjectRunLockHandle = { release: () => Promise<void> };

// Acquire the per-project run lock or throw. `label` is logged into the
// lockfile so a developer inspecting `~/.lattice/per-project/<hash>/run.lock`
// can tell what's holding it (e.g. `merge-run`, `manual-merge`).
export async function acquireProjectRunLock(
  projectPath: string,
  label: string,
): Promise<ProjectRunLockHandle> {
  const file = lockFilePath(projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body: LockBody = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    label,
  };
  // Two attempts: first try, and if EEXIST + the holder is dead, steal
  // and retry. Beyond that we surface the error so the caller can fail
  // the request — better than spinning indefinitely.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fh = await fs.open(file, 'wx');
      try {
        await fh.write(JSON.stringify(body, null, 2), 0, 'utf8');
      } finally {
        await fh.close();
      }
      return {
        release: async () => {
          // Only delete if we still own it — pid match avoids racing with
          // a stolen-lock takeover by a sibling process.
          const current = await readLockBody(file);
          if (current?.pid === process.pid) {
            await fs.unlink(file).catch(() => undefined);
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readLockBody(file);
      if (!holder) {
        // Lockfile exists but we can't parse it. Treat as stale and steal.
        console.warn(
          `[projectRunLock] unparseable lockfile at ${file} — stealing`,
        );
        await fs.unlink(file).catch(() => undefined);
        continue;
      }
      // Same-process re-entry would deadlock the merge run worker. The
      // in-process locks (mergeLocks.ts, the singleton run check in
      // mergeRuns.ts) are responsible for catching this case before we
      // get here; if they didn't, refuse rather than silently pretending
      // we're the holder.
      if (holder.pid === process.pid && holder.hostname === os.hostname()) {
        throw new ProjectRunLockedError(holder);
      }
      // Different host = always treat as alive (we can't probe a remote
      // PID from here). Same host: probe the PID.
      const sameHost = holder.hostname === os.hostname();
      if (sameHost && !isProcessAlive(holder.pid)) {
        console.warn(
          `[projectRunLock] stealing dead lock held by pid=${holder.pid} ` +
            `(label=${holder.label}, started ${new Date(holder.startedAt).toISOString()})`,
        );
        await fs.unlink(file).catch(() => undefined);
        continue;
      }
      throw new ProjectRunLockedError(holder);
    }
  }
  // Shouldn't reach here — the loop either returns or throws.
  throw new Error('[projectRunLock] failed to acquire after retries');
}

// Convenience for the "do work, always release" pattern. Runs `fn` with
// the lock held; releases on success and on throw.
export async function withProjectRunLock<T>(
  projectPath: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireProjectRunLock(projectPath, label);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
