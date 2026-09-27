// Git housekeeping for a project repo, run by Lattice ONCE after a merge run —
// never by git itself mid-burst (see gitAutoGc.ts for the 80 GB runaway that
// auto-gc caused on Windows).
//
//   1. Sweep the debris failed repacks leave in the object store, which git
//      never cleans up by itself: `tmp_pack_*` / `tmp_idx_*` / `tmp_obj_*`
//      from a killed pack-objects, and `pack-*.pack` files whose `.idx` is
//      gone (git removed the index but Windows refused to delete the mapped
//      pack; git cannot read a pack without its index, so it is dead weight).
//      Only files older than PACK_DEBRIS_MIN_AGE_MS, only while no gc holds
//      `gc.pid`, single-file unlinks inside `objects/` — never recursive, never
//      a `.keep` pack.
//   2. `git gc --auto` in the foreground (auto-gc is otherwise off for every
//      git Lattice runs), so the loose objects a run of merges produces still
//      get packed — but only when the disk can hold another full copy of the
//      packs above the free-space reserve, and never while the project is
//      merging. The gc holds the project run lock (non-lendable, label
//      REPO_MAINTENANCE_LOCK_LABEL) for its whole duration, so no merge run,
//      manual /merge, workflow Merge step or resolver finalize can start while
//      it repacks: their git processes would map the old packs and, on Windows,
//      the repack could not delete them — a full leftover copy of the packs
//      per maintenance (9af5a47). startMergeRun refuses while maintenance is in
//      flight (isRepoMaintenanceRunning, RepoMaintenanceBusyError), the workflow
//      control steps wait for it (waitForRepoMaintenance), and callback-driven
//      restarts wait and retry (startMergeRunAfterMaintenance).

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectGit } from './projectGit.js';
import { freeBytesAt, formatBytes, minFreeDiskBytes } from './diskSpace.js';
import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  REPO_MAINTENANCE_LOCK_LABEL,
  type ProjectRunLockHandle,
} from '../projectRunLock.js';

export const PACK_DEBRIS_MIN_AGE_MS = 6 * 60 * 60_000;
// git treats a gc.pid older than 12 h as stale.
const GC_PID_STALE_MS = 12 * 60 * 60_000;
const GC_TIMEOUT_MS = 60 * 60_000;
// rev-parse answers instantly; the bound only stops a wedged git from stalling
// maintenance.
const GIT_PROBE_TIMEOUT_MS = 15_000;
// count-objects walks the whole object store, which is slow on a large repo
// with many loose objects — well under the gc bound, well above a probe.
const COUNT_OBJECTS_TIMEOUT_MS = 60_000;
// Upper bound for a waiter: the gc's own timeout plus slack for the sweep /
// count-objects around it. The in-flight promise always settles before this.
export const REPO_MAINTENANCE_MAX_WAIT_MS = GC_TIMEOUT_MS + 5 * 60_000;

export type RepoMaintenanceDeps = {
  now: () => number;
  freeBytesAt: typeof freeBytesAt;
  minFreeBytes: () => Promise<number>;
  // true while something else is merging in the project (skip entirely).
  isBusy: (repoRoot: string) => boolean;
  acquireLock: (repoRoot: string) => Promise<ProjectRunLockHandle>;
  runGc: (repoRoot: string) => Promise<{ code: number; stdout: string; stderr: string }>;
};

const defaultDeps: RepoMaintenanceDeps = {
  now: () => Date.now(),
  freeBytesAt,
  minFreeBytes: minFreeDiskBytes,
  isBusy: () => false,
  acquireLock: (repoRoot) => acquireProjectRunLock(repoRoot, REPO_MAINTENANCE_LOCK_LABEL, { lendable: false }),
  runGc: (repoRoot) => projectGit(repoRoot, ['gc', '--auto', '--quiet'], { timeoutMs: GC_TIMEOUT_MS, autoGc: 'foreground' }),
};

async function commonGitDir(repoRoot: string): Promise<string | null> {
  const r = await projectGit(repoRoot, ['rev-parse', '--git-common-dir'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
  const dir = r.code === 0 ? r.stdout.trim() : '';
  return dir ? path.resolve(repoRoot, dir) : null;
}

async function ageMs(file: string, now: number): Promise<number | null> {
  try {
    const st = await fs.lstat(file);
    return st.isFile() ? now - st.mtimeMs : null;
  } catch {
    return null;
  }
}

// Step 1. Returns the files removed and bytes freed.
export async function sweepPackDebris(
  gitDir: string,
  deps: Pick<RepoMaintenanceDeps, 'now'> = defaultDeps,
): Promise<{ removed: string[]; bytes: number }> {
  const out = { removed: [] as string[], bytes: 0 };
  const now = deps.now();
  const gcPidAge = await ageMs(path.join(gitDir, 'gc.pid'), now);
  if (gcPidAge !== null && gcPidAge < GC_PID_STALE_MS) return out; // a gc may be writing these right now

  const objects = path.join(gitDir, 'objects');
  const packDir = path.join(objects, 'pack');
  const candidates: string[] = [];
  let packNames: string[] = [];
  try {
    packNames = await fs.readdir(packDir);
  } catch {
    return out;
  }
  const names = new Set(packNames);
  for (const name of packNames) {
    if (/^tmp_(pack|idx|rev|bitmap)_/.test(name)) candidates.push(path.join(packDir, name));
    const m = /^(pack-[0-9a-f]+)\.pack$/.exec(name);
    if (m && !names.has(`${m[1]}.idx`) && !names.has(`${m[1]}.keep`)) {
      candidates.push(path.join(packDir, name));
      for (const ext of ['rev', 'mtimes', 'bitmap']) {
        if (names.has(`${m[1]}.${ext}`)) candidates.push(path.join(packDir, `${m[1]}.${ext}`));
      }
    }
  }
  for (const fan of await fs.readdir(objects).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(fan)) continue;
    for (const name of await fs.readdir(path.join(objects, fan)).catch(() => [] as string[])) {
      if (name.startsWith('tmp_obj_')) candidates.push(path.join(objects, fan, name));
    }
  }
  for (const file of candidates) {
    const age = await ageMs(file, now);
    if (age === null || age < PACK_DEBRIS_MIN_AGE_MS) continue;
    try {
      const size = (await fs.lstat(file)).size;
      await fs.unlink(file);
      out.removed.push(file);
      out.bytes += size;
    } catch {
      /* still mapped by a git process — next time */
    }
  }
  return out;
}

// Packed size in bytes (`git count-objects -v` size-pack is KiB), or null.
async function packedBytes(repoRoot: string): Promise<number | null> {
  const r = await projectGit(repoRoot, ['count-objects', '-v'], { timeoutMs: COUNT_OBJECTS_TIMEOUT_MS });
  if (r.code !== 0) return null;
  const m = /^size-pack:\s*(\d+)/m.exec(r.stdout);
  return m ? Number(m[1]) * 1024 : null;
}

const inFlight = new Map<string, Promise<void>>();

const maintenanceKey = (repoRoot: string): string => path.resolve(repoRoot).toLowerCase();

// True while this process's housekeeping for `repoRoot` is in flight.
export function isRepoMaintenanceRunning(repoRoot: string): boolean {
  return inFlight.has(maintenanceKey(repoRoot));
}

// Resolves once no housekeeping for `repoRoot` is in flight: true when idle,
// false if still running after `maxWaitMs`. Never rejects.
export async function waitForRepoMaintenance(
  repoRoot: string,
  maxWaitMs: number = REPO_MAINTENANCE_MAX_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const running = inFlight.get(maintenanceKey(repoRoot));
    if (!running) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      running.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), left);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) return false;
  }
}

// Run the housekeeping for `repoRoot`; single-flight per repo; never throws.
export function runRepoMaintenance(repoRoot: string, overrides: Partial<RepoMaintenanceDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const key = maintenanceKey(repoRoot);
  const running = inFlight.get(key);
  if (running) return running;
  const p = maintain(repoRoot, deps)
    .catch((err) => console.warn(`[git-maintenance] ${repoRoot}: failed:`, err))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function maintain(repoRoot: string, deps: RepoMaintenanceDeps): Promise<void> {
  if (deps.isBusy(repoRoot)) return;
  const gitDir = await commonGitDir(repoRoot);
  if (!gitDir) return;
  const swept = await sweepPackDebris(gitDir, deps);
  if (swept.removed.length > 0) {
    console.warn(
      `[git-maintenance] ${repoRoot}: removed ${swept.removed.length} leftover file(s) of failed repacks ` +
        `(${formatBytes(swept.bytes)}) — temp packs and packs whose index was already deleted`,
    );
  }
  const packed = await packedBytes(repoRoot);
  const free = await deps.freeBytesAt(gitDir);
  const reserve = await deps.minFreeBytes();
  if (packed === null || free === null) return;
  // A full repack writes a complete new copy before deleting the old ones.
  if (free - packed * 1.1 < reserve) {
    console.warn(
      `[git-maintenance] ${repoRoot}: skipping git gc — a repack needs ~${formatBytes(packed)}, ` +
        `${formatBytes(free)} is free and ${formatBytes(reserve)} is kept in reserve`,
    );
    return;
  }
  if (deps.isBusy(repoRoot)) return;
  // Hold the project run lock across the gc: a merge that started after the
  // isBusy check above would otherwise run alongside a multi-GB repack. If
  // anything holds it (a merge, a workflow step, another process), skip.
  let lock: ProjectRunLockHandle;
  try {
    lock = await deps.acquireLock(repoRoot);
  } catch (err) {
    if (err instanceof ProjectRunLockedError) return;
    throw err;
  }
  try {
    if (deps.isBusy(repoRoot)) return;
    const gc = await deps.runGc(repoRoot);
    if (gc.code !== 0) {
      console.warn(`[git-maintenance] ${repoRoot}: git gc --auto exited ${gc.code}: ${gc.stderr.trim() || gc.stdout.trim()}`);
    }
  } finally {
    await lock.release().catch(() => undefined);
  }
}
