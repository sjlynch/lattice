// Clear the lock files a killed git process leaves in the project repo.
//
// Git takes `.git/index.lock` (and `HEAD.lock`, `<ref>.lock`, …) with an
// exclusive create and removes it when done; a git killed mid-operation — a
// crash, an ENOSPC, a `taskkill` of the process tree — leaves it behind, and
// every later index-writing command then fails with
// `Unable to create '…/index.lock': File exists`. On 2026-09-23 one such file
// (left by a disk-full crash) made a 25-task merge run fail all 25
// fast-forwards, and nothing would ever have cleared it.
//
// A lock is removed only when it is certainly abandoned:
//   - older than STALE_AFTER_MS (no index write takes that long; a libgit2
//     tool — which runs under its own process name — is covered by this), and
//   - no running `git` / `git-*` process started before the lock was written.
//     The holder must have been running when it created the file, so a git
//     process that started later cannot be it. A process whose start time
//     cannot be read counts as a possible holder, and so does a failed
//     process listing.
// It is a single-file `unlink` of a regular file inside the git dir, never a
// recursive delete (see the `.git`-deletion defences in ./CLAUDE.md).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from './exec.js';
import { projectGit } from './projectGit.js';

export const STALE_GIT_LOCK_AFTER_MS = 10 * 60_000;
// Process start times and file mtimes come from different clocks' rounding.
const START_TIME_SLACK_MS = 2_000;
// Local rev-parse / symbolic-ref probes answer instantly; the bound only stops a
// wedged git (e.g. a hung filesystem) from stalling lock recovery.
const GIT_PROBE_TIMEOUT_MS = 15_000;
// Listing every process (PowerShell startup on Windows) can be slow on a busy
// machine, so it gets more headroom than a git probe.
const PROCESS_LIST_TIMEOUT_MS = 20_000;

export type BlockingGitLock = {
  path: string;
  ageMs: number;
  reason: 'fresh' | 'held' | 'unknown';
};

export type StaleGitLockReport = {
  cleared: string[];
  blocking: BlockingGitLock[];
};

export type StaleGitLockDeps = {
  lockCandidates: (repoRoot: string) => Promise<string[]>;
  mtimeMs: (file: string) => Promise<number | null>;
  // Start times (epoch ms) of every running git process; NaN for one whose
  // start time is unreadable; null when processes cannot be listed.
  gitProcessStartTimes: () => Promise<number[] | null>;
  unlink: (file: string) => Promise<void>;
  now: () => number;
};

// `Unable to create '<path>.lock': File exists.` — git's wording for a lock
// collision. Returns the lock path, or null.
export function gitLockPathFromError(message: string): string | null {
  const m = /Unable to create '([^']+\.lock)': File exists/.exec(message);
  return m ? m[1] : null;
}

async function lockCandidates(repoRoot: string): Promise<string[]> {
  const dirs = await projectGit(repoRoot, ['rev-parse', '--absolute-git-dir', '--git-common-dir'], {
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
  });
  if (dirs.code !== 0) return [];
  const [gitDirRaw, commonRaw] = dirs.stdout.split(/\r?\n/).map((s) => s.trim());
  if (!gitDirRaw) return [];
  const gitDir = path.resolve(repoRoot, gitDirRaw);
  const commonDir = commonRaw ? path.resolve(repoRoot, commonRaw) : gitDir;
  const out = [
    path.join(gitDir, 'index.lock'),
    path.join(gitDir, 'HEAD.lock'),
    path.join(gitDir, 'ORIG_HEAD.lock'),
    path.join(commonDir, 'packed-refs.lock'),
  ];
  const head = await projectGit(repoRoot, ['symbolic-ref', '-q', 'HEAD'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
  const ref = head.code === 0 ? head.stdout.trim() : '';
  if (/^refs\/heads\/[^\0]+$/.test(ref) && !ref.split('/').includes('..')) {
    out.push(path.join(commonDir, ...ref.split('/')) + '.lock');
  }
  return out;
}

async function mtimeMs(file: string): Promise<number | null> {
  try {
    const st = await fs.lstat(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

// `[[dd-]hh:]mm:ss` (ps etime) → ms.
export function parseEtimeMs(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60_000 + Number(s) * 1000;
}

async function gitProcessStartTimes(): Promise<number[] | null> {
  try {
    if (process.platform === 'win32') {
      const script =
        "Get-Process | Where-Object { $_.ProcessName -eq 'git' -or $_.ProcessName -like 'git-*' } | " +
        'ForEach-Object { try { ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { -1 } }';
      const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], os.tmpdir(), {
        timeoutMs: PROCESS_LIST_TIMEOUT_MS,
      });
      if (r.code !== 0) return null;
      return r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (Number(l) > 0 ? Number(l) : NaN));
    }
    const r = await exec('ps', ['-A', '-o', 'etime=,comm='], os.tmpdir(), { timeoutMs: PROCESS_LIST_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const now = Date.now();
    const out: number[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\S+)\s+(.+)$/.exec(line);
      if (!m || !/^git(-|$)/.test(path.basename(m[2].trim()))) continue;
      const elapsed = parseEtimeMs(m[1]);
      out.push(elapsed === null ? NaN : now - elapsed);
    }
    return out;
  } catch {
    return null;
  }
}

export const defaultStaleGitLockDeps: StaleGitLockDeps = {
  lockCandidates,
  mtimeMs,
  gitProcessStartTimes,
  unlink: (file) => fs.unlink(file),
  now: () => Date.now(),
};

// Remove every abandoned git lock file in `repoRoot`'s git dir; report the
// ones left in place. Never throws.
export async function clearStaleGitLocks(
  repoRoot: string,
  deps: StaleGitLockDeps = defaultStaleGitLockDeps,
): Promise<StaleGitLockReport> {
  const report: StaleGitLockReport = { cleared: [], blocking: [] };
  try {
    const present: { file: string; mtime: number }[] = [];
    for (const file of await deps.lockCandidates(repoRoot)) {
      const mtime = await deps.mtimeMs(file);
      if (mtime !== null) present.push({ file, mtime });
    }
    if (present.length === 0) return report;

    let starts: number[] | null | undefined;
    for (const { file, mtime } of present) {
      const ageMs = deps.now() - mtime;
      if (ageMs < STALE_GIT_LOCK_AFTER_MS) {
        report.blocking.push({ path: file, ageMs, reason: 'fresh' });
        continue;
      }
      if (starts === undefined) starts = await deps.gitProcessStartTimes();
      if (starts === null) {
        report.blocking.push({ path: file, ageMs, reason: 'unknown' });
        continue;
      }
      if (starts.some((t) => Number.isNaN(t) || t <= mtime + START_TIME_SLACK_MS)) {
        report.blocking.push({ path: file, ageMs, reason: 'held' });
        continue;
      }
      // Re-check right before removing: a file re-created since the scan has a
      // new mtime and belongs to a live process.
      if ((await deps.mtimeMs(file)) !== mtime) continue;
      try {
        await deps.unlink(file);
        report.cleared.push(file);
        console.warn(
          `[git-lock] removed abandoned ${file} (${Math.round(ageMs / 60_000)} min old, ` +
            'no running git process predates it — a git process was killed mid-operation)',
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          report.blocking.push({ path: file, ageMs, reason: 'unknown' });
        }
      }
    }
  } catch (err) {
    console.warn(`[git-lock] stale-lock check failed for ${repoRoot}:`, err);
  }
  return report;
}

export function describeBlockingLocks(blocking: BlockingGitLock[]): string {
  return blocking
    .map((b) => {
      const age = `${Math.round(b.ageMs / 1000)}s old`;
      const why =
        b.reason === 'fresh'
          ? 'recent — probably a git command still running'
          : b.reason === 'held'
            ? 'a running git process may own it'
            : 'could not tell whether a git process owns it';
      return `${b.path} (${age}; ${why})`;
    })
    .join('; ');
}
