// Reclaim residue under `~/.lattice/worktrees/<hash>/` from a part-failed
// `git worktree remove --force`: on Windows a locked file (a pnpm hard link to a
// running `esbuild.exe` / `rollup.*.node`, a dev server that outlived its pty)
// stops git AFTER it dropped the registration and `.git` file, leaving a dir
// neither `cleanupWorktreeForTask` nor `sweepOrphanedWorktrees` ever revisits. A
// locked entry sorting before `.git` leaves the `.git` FILE pointing at a gone
// admin dir — residue too.
//
// Deliberately narrow — removes only a direct child of a KNOWN project's home
// worktrees dir that
//   - git has no registration for (re-read immediately before the delete),
//   - no in_progress / ready_to_merge / queued task records as its worktree,
//   - no live pty sits in,
//   - is not a reparse point and has no `.git` marker — or only a `.git` FILE
//     whose `gitdir:` names a `<commonDir>/worktrees/<id>` of THIS repo that no
//     longer exists, while the common dir is intact (re-checked before delete),
//   - is untouched for RESIDUE_MIN_AGE_MS (since git's failed remove).
// i.e. no checkout at all (cleanup archived its edits before the remove).
// Deletes are guarded like every scratch delete (reparse-point check + junction
// pruning first); a still-locked dir backs off in memory. Never touches unknown
// projects' hash dirs or legacy `<repo>/.lattice/worktrees`. Schedule + rules:
// recovery/CLAUDE.md → "Worktree residue sweep".

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../tasks.js';
import { homeWorktreesDir } from '../projectPath.js';
import { parseWorktreesPorcelain } from '../worktree/state.js';
import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';
import { isPathStrictlyInside } from '../worktree/paths.js';
import { notifyDiskSpaceFreed } from '../spawnQueue.js';
import { hasLiveSessionAtOrUnder, normalizeCwd } from './liveSessions.js';
import { classifyGitMarker, commonGitDirVia } from './worktreeResidueGitMarker.js';
import type { projectGit as ProjectGit } from '../worktree/projectGit.js';

const RESIDUE_MIN_AGE_MS = 10 * 60_000;
// Per-dir backoff after a failed (locked) delete: 30 min, 1 h, 2 h, … capped.
const LOCKED_BACKOFF_BASE_MS = 30 * 60_000;
const LOCKED_BACKOFF_MAX_MS = 8 * 60 * 60_000;
const LOGGED_ENTRIES_MAX = 20;
const ACTIVE_STATUSES = new Set(['in_progress', 'ready_to_merge']);
// `removed|locked|waiting` of a pass that did nothing — a project's first pass
// logs no summary when it is this.
const QUIET_SUMMARY = '0|0|0';

type LockedBackoff = { failures: number; retryAt: number };

export type ResidueSweepDeps = {
  projectGit: typeof ProjectGit;
  removeDir: (dir: string) => Promise<boolean>;
  now: () => number;
  worktreesDir: (repoRoot: string) => string;
  // Optional so hand-built test deps keep compiling.
  notifyDiskSpaceFreed?: () => void;
  // The repo's common gitdir (absolute), or null when unknown. Defaults to
  // `git rev-parse --git-common-dir` through `projectGit`.
  commonGitDir?: (repoRoot: string) => Promise<string | null>;
};

export type ResidueSweepOptions = {
  // `[startup]` for the boot pass; the periodic / disk-wait passes use their own.
  logPrefix?: string;
};

// In-memory only: a restart retries everything once, which is what we want.
const lockedBackoff = new Map<string, LockedBackoff>();
// Last logged per-project summary, so a pass logs only when its counts change.
const lastSummary = new Map<string, string>();
// Per-project single-flight shared by the boot, periodic and disk-wait passes.
const projectsInFlight = new Set<string>();

// One guarded attempt, no retries and no per-dir failure log: a lock (the
// common case — see above) fails the same way for many dirs, and retrying or
// logging each would flood the log. The per-pass summary reports them.
async function removeResidueDir(dir: string): Promise<boolean> {
  try {
    await assertNotReparsePoint(dir);
    await pruneReparsePointsUnder(dir);
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const defaultDeps = (projectGit: typeof ProjectGit): ResidueSweepDeps => ({
  projectGit,
  removeDir: removeResidueDir,
  now: () => Date.now(),
  worktreesDir: homeWorktreesDir,
  notifyDiskSpaceFreed,
});

type Registrations = { paths: Set<string>; names: Set<string> };

function foldName(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

// Exact registered paths, plus the basenames of registrations whose parent dir
// has this hash dir's name — a second key that still matches when git reports
// the same checkout under a different spelling of the home dir (8.3 alias,
// junctioned profile), so such a checkout can never read as unregistered.
async function readRegistrations(
  deps: ResidueSweepDeps,
  repoRoot: string,
  base: string,
): Promise<Registrations | null> {
  const listed = await deps.projectGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (listed.code !== 0) return null; // can't prove anything is unregistered
  const entries = parseWorktreesPorcelain(listed.stdout);
  if (entries.length === 0) return null; // the main worktree is always listed
  const baseName = foldName(path.basename(base));
  const names = new Set<string>();
  for (const wt of entries) {
    if (foldName(path.basename(path.dirname(path.resolve(wt.path)))) === baseName) {
      names.add(foldName(path.basename(path.resolve(wt.path))));
    }
  }
  return { paths: new Set(entries.map((wt) => normalizeCwd(wt.path))), names };
}

function isRegistered(reg: Registrations, dir: string): boolean {
  return reg.paths.has(normalizeCwd(dir)) || reg.names.has(foldName(path.basename(dir)));
}

function describeEntries(entries: string[]): string {
  if (entries.length === 0) return '(empty)';
  const shown = [...entries].sort().slice(0, LOGGED_ENTRIES_MAX).join(', ');
  return entries.length > LOGGED_ENTRIES_MAX ? `${shown}, … +${entries.length - LOGGED_ENTRIES_MAX} more` : shown;
}

export async function sweepWorktreeResidue(
  repoRoot: string,
  tasks: Task[],
  liveCwds: Set<string>,
  projectGit: typeof ProjectGit,
  deps: ResidueSweepDeps = defaultDeps(projectGit),
  opts: ResidueSweepOptions = {},
): Promise<number> {
  const base = path.resolve(deps.worktreesDir(repoRoot));
  const key = normalizeCwd(base);
  if (projectsInFlight.has(key)) return 0; // another pass is on this project
  projectsInFlight.add(key);
  try {
    return await sweepProjectResidue(repoRoot, base, tasks, liveCwds, deps, opts.logPrefix ?? '[startup]');
  } finally {
    projectsInFlight.delete(key);
  }
}

async function sweepProjectResidue(
  repoRoot: string,
  base: string,
  tasks: Task[],
  liveCwds: Set<string>,
  deps: ResidueSweepDeps,
  logPrefix: string,
): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch {
    return 0; // no worktrees dir for this project
  }
  const registered = await readRegistrations(deps, repoRoot, base);
  if (!registered) return 0;
  const owned = new Set(
    tasks
      .filter((t) => (ACTIVE_STATUSES.has(t.status) || t.runQueued) && t.worktreePath)
      .map((t) => normalizeCwd(t.worktreePath as string)),
  );

  // Resolved at most once per pass, and only if some dir carries a `.git`.
  let commonDirPromise: Promise<string | null> | null = null;
  const resolveCommonDir = deps.commonGitDir ?? ((r: string) => commonGitDirVia(deps.projectGit, r));
  const commonDir = () => (commonDirPromise ??= resolveCommonDir(repoRoot).catch(() => null));

  let removed = 0;
  let lockedCount = 0;
  let waiting = 0;
  const seen = new Set<string>();
  for (const name of names) {
    const dir = path.join(base, name);
    // Belt-and-braces: only ever a direct child of the home worktrees dir,
    // which lives outside every project tree.
    if (!isPathStrictlyInside(base, dir) || path.dirname(path.resolve(dir)) !== base) continue;
    const dirKey = normalizeCwd(dir);
    seen.add(dirKey);
    if (isRegistered(registered, dir) || owned.has(dirKey) || hasLiveSessionAtOrUnder(liveCwds, dir)) continue;
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const now = deps.now();
    if (now - st.mtimeMs < RESIDUE_MIN_AGE_MS) continue;
    const backoff = lockedBackoff.get(dirKey);
    if (backoff && now < backoff.retryAt) {
      waiting += 1;
      continue;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    // A `.git` marker may belong to a moved/repairable checkout or another
    // repo entirely — never ours to recursively erase, unless it is the
    // dangling pointer a part-failed `git worktree remove` leaves behind.
    const marker = await classifyGitMarker(dir, entries, commonDir);
    if (marker === 'keep') continue;

    // Re-check immediately before the delete (same as worktree/reconcile.ts's
    // stray removal): a setup may have registered this path, or written its
    // `.git`, since the inventory above was taken.
    const fresh = await readRegistrations(deps, repoRoot, base);
    if (!fresh) break; // lost the ability to prove "unregistered" — stop here
    if (isRegistered(fresh, dir)) continue;
    let freshEntries: string[];
    try {
      freshEntries = await fs.readdir(dir);
    } catch {
      continue;
    }
    if ((await classifyGitMarker(dir, freshEntries, commonDir)) === 'keep') continue;

    if (await deps.removeDir(dir)) {
      removed += 1;
      lockedBackoff.delete(dirKey);
      // Ignored files (`tmp/`, build output, …) are never in the
      // discarded-worktree archive, so say what went.
      const why = marker === 'orphaned' ? '; its .git pointed at a removed worktree admin dir' : '';
      console.log(`${logPrefix} residue sweep: removed ${dir} (top-level: ${describeEntries(entries)}${why})`);
    } else {
      lockedCount += 1;
      lockedBackoff.set(dirKey, nextBackoff(backoff, deps.now()));
    }
  }
  // Forget backoff state for dirs that are gone (removed by hand, or by git).
  for (const k of lockedBackoff.keys()) {
    if (isPathStrictlyInside(base, k) && !seen.has(k)) lockedBackoff.delete(k);
  }

  // A failed `fs.rm` still deletes everything around the locked file, so an
  // attempt of either kind freed disk: wake runs waiting on it.
  if (removed + lockedCount > 0) deps.notifyDiskSpaceFreed?.();

  logSweepSummary(base, logPrefix, removed, lockedCount, waiting);
  return removed;
}

// Backoff after one more failed (locked) delete: 30 min, 1 h, 2 h, … capped.
function nextBackoff(previous: LockedBackoff | undefined, now: number): LockedBackoff {
  const failures = (previous?.failures ?? 0) + 1;
  const delay = Math.min(LOCKED_BACKOFF_BASE_MS * 2 ** (failures - 1), LOCKED_BACKOFF_MAX_MS);
  return { failures, retryAt: now + delay };
}

// One line per project, only when the counts changed since its last pass.
function logSweepSummary(base: string, logPrefix: string, removed: number, lockedCount: number, waiting: number): void {
  const summaryKey = normalizeCwd(base);
  const summary = `${removed}|${lockedCount}|${waiting}`;
  const previous = lastSummary.get(summaryKey);
  if (summary !== previous && !(previous === undefined && summary === QUIET_SUMMARY)) {
    console.log(
      `${logPrefix} residue sweep: ${base}: removed ${removed} leftover dir(s); ` +
        `${lockedCount} still locked (usually a running esbuild/vite/dev server holding a file) — ` +
        `retrying with backoff; ${waiting} waiting out an earlier lock`,
    );
  }
  lastSummary.set(summaryKey, summary);
}

// Test seam.
export function resetResidueSweepStateForTests(): void {
  lockedBackoff.clear();
  lastSummary.clear();
  projectsInFlight.clear();
}
