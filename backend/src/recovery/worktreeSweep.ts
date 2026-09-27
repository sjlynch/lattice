import path from 'node:path';
import { listTasks, type Task } from '../tasks.js';
import {
  cleanupWorktreeForTask,
  gitDirExists,
  isUnderManagedWorktreesDir,
  parseWorktreesPorcelain,
  projectGit,
  type ParsedWorktree,
} from '../worktree.js';
import { archiveUncommittedWorktreeChanges } from '../worktree/discardArchive.js';
import { sweepWorktreeResidue } from './worktreeResidueSweep.js';
import { clearStaleInitializingLock } from '../worktree/staleInitLock.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { forEachWithConcurrency } from './concurrency.js';
import { collectLiveSessionCwds, hasLiveSessionAtOrUnder, normalizeCwd } from './liveSessions.js';

// Tasks whose worktree we must not touch — they have a live (or
// resumable) Claude session pointed at it.
const ACTIVE_STATUSES = new Set(['in_progress', 'ready_to_merge']);
// Tasks that may still be run or resumed: a checkout of theirs whose branch
// holds unmerged commits is left completely alone.
const RERUNNABLE_STATUSES = new Set(['open', 'backlog']);
// Checkout removals in flight at once (each is a large recursive delete).
const SWEEP_CONCURRENCY = 2;
const LOGGED_BRANCHES_MAX = 5;

// For every known project, reconcile `git worktree list` against the live
// task set: any worktree git still tracks that (a) lives under a
// Lattice-managed worktrees directory, (b) is not the main worktree, and
// (c) is not referenced by an in_progress / ready_to_merge task is an
// orphan — left behind by a finalize whose background cleanup failed, a
// crashed run, or a pre-2026-05-10 in-project worktree. We tear it down
// via `cleanupWorktreeForTask` (which delegates the recursive delete to
// `git worktree remove --force` — no raw fs.rm) and remove only their exact
// registrations. This is what makes "leave the dir, retry at boot"
// (cleanup.ts) actually converge.
export type WorktreeSweepDeps = {
  forEachKnownProjectSafely: typeof forEachKnownProjectSafely;
  listTasks: typeof listTasks;
  gitDirExists: typeof gitDirExists;
  projectGit: typeof projectGit;
  cleanupWorktreeForTask: typeof cleanupWorktreeForTask;
  collectLiveSessionCwds: typeof collectLiveSessionCwds;
  // Optional so hand-built test deps keep compiling; defaults to the real one.
  archiveUncommitted?: typeof archiveUncommittedWorktreeChanges;
  // Optional for the same reason; absent → no residue sweep.
  sweepResidue?: typeof sweepWorktreeResidue;
};

const defaultDeps: WorktreeSweepDeps = {
  forEachKnownProjectSafely, listTasks, gitDirExists, projectGit,
  cleanupWorktreeForTask, collectLiveSessionCwds,
  archiveUncommitted: archiveUncommittedWorktreeChanges,
  sweepResidue: sweepWorktreeResidue,
};

export async function sweepOrphanedWorktrees(deps: WorktreeSweepDeps = defaultDeps): Promise<void> {
  // Detached PTYs survive a backend restart. Without an authoritative session
  // inventory we cannot prove a worktree is abandoned, so defer reclamation.
  const liveCwds = await deps.collectLiveSessionCwds();
  if (liveCwds === null) {
    console.warn('[startup] worktree sweep: terminal-server unreachable — skipping reclamation');
    return;
  }
  await deps.forEachKnownProjectSafely('sweepOrphanedWorktrees', (repoRoot) => sweepProject(repoRoot, liveCwds, deps));
}

async function sweepProject(repoRoot: string, liveCwds: Set<string>, deps: WorktreeSweepDeps): Promise<void> {
  if (!(await deps.gitDirExists(repoRoot))) return; // project moved/deleted

  // A failed task read is NOT an empty task list. Let the per-project guard
  // report it and continue with other projects before any destructive work.
  const tasks = await deps.listTasks(repoRoot);
  // The store also preserves corrupt JSON and returns its empty default.
  // With zero records we cannot tell "all tasks were deleted" from "the
  // ownership database could not be recovered". Leave checkouts available
  // for manual recovery rather than force-removing potentially unique work.
  if (tasks.length === 0) {
    console.warn(`[startup] worktree sweep: no task ownership records for ${repoRoot} — skipping reclamation`);
    return;
  }
  const wtList = await deps.projectGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (wtList.code !== 0) {
    console.warn(
      `[startup] sweep: 'git worktree list' in ${repoRoot} exit ${wtList.code}: ${wtList.stderr.trim()}`,
    );
    return;
  }
  const worktrees = parseWorktreesPorcelain(wtList.stdout);

  const owners = worktreeOwners(tasks);
  const unmergedRefs = await listUnmergedLatticeRefs(deps, repoRoot);
  let removed = 0;
  const keptBranches: string[] = [];
  const skippedRerunnable: string[] = [];

  const candidates = selectOrphanCandidates(worktrees, repoRoot, tasks, liveCwds);

  await forEachWithConcurrency(candidates, SWEEP_CONCURRENCY, async (wt) => {
    try {
      const outcome = await reclaimOrphan(deps, repoRoot, wt, owners, unmergedRefs);
      if (outcome.kind === 'skipped-rerunnable') {
        skippedRerunnable.push(outcome.branch);
      } else if (outcome.kind === 'removed' || outcome.kind === 'kept') {
        if (outcome.keptBranch !== undefined) keptBranches.push(outcome.keptBranch);
        if (outcome.kind === 'removed') removed += 1;
      }
    } catch (err) {
      console.error(`[startup] sweep: cleanup of ${path.resolve(wt.path)} failed:`, err);
    }
  });

  logSweepSummary(repoRoot, removed, keptBranches, skippedRerunnable);

  // Unregistered leftovers of a part-failed `git worktree remove` (see
  // worktreeResidueSweep.ts). Detached: hundreds of them may be locked, and
  // boot must not wait on that.
  if (deps.sweepResidue) {
    void deps.sweepResidue(repoRoot, tasks, liveCwds, deps.projectGit).catch((err) => {
      console.warn(`[startup] residue sweep failed for ${repoRoot}:`, err);
    });
  }
}

// Registered worktrees that may be orphans: not the main worktree, under a
// Lattice-managed worktrees directory, not owned by an active/queued task,
// and with no live session at or under them.
function selectOrphanCandidates(
  worktrees: ParsedWorktree[],
  repoRoot: string,
  tasks: Task[],
  liveCwds: Set<string>,
): ParsedWorktree[] {
  const activeWorktreePaths = getActiveWorktreePaths(tasks);
  const repoResolved = normalizeCwd(repoRoot);
  return worktrees.filter((wt) => {
    const resolved = path.resolve(wt.path);
    if (normalizeCwd(resolved) === repoResolved) return false; // the main worktree
    if (!isUnderManagedWorktreesDir(resolved, repoRoot)) return false; // not ours
    if (activeWorktreePaths.has(normalizeCwd(resolved))) return false; // a live task owns it
    return !hasLiveSessionAtOrUnder(liveCwds, resolved);
  });
}

// What reclaiming one orphan did. `removed` / `kept`: cleanup did / did not
// remove the checkout; `keptBranch` names a `lattice/*` branch it kept
// because that branch holds commits not on HEAD.
type OrphanOutcome =
  | { kind: 'locked' }
  | { kind: 'skipped-rerunnable'; branch: string }
  | { kind: 'archive-failed' }
  | { kind: 'removed'; keptBranch?: string }
  | { kind: 'kept'; keptBranch?: string };

async function reclaimOrphan(
  deps: WorktreeSweepDeps,
  repoRoot: string,
  wt: ParsedWorktree,
  owners: Map<string, Task>,
  unmergedRefs: Set<string> | null,
): Promise<OrphanOutcome> {
  const resolved = path.resolve(wt.path);
  // An explicit Git lock preserves even an absent checkout — except git's
  // own stale "initializing" lock from an interrupted `worktree add`.
  const interruptedAdd = !!wt.locked && await clearStaleInitializingLock(repoRoot, wt);
  if (wt.locked && !interruptedAdd) return { kind: 'locked' };

  const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : '';
  // Unmerged commits on the branch are the only copy of that work, so the
  // BRANCH is never deleted here (`keepBranchIfUnmerged`) — but the
  // checkout is disposable once its uncommitted edits are archived, and it
  // is what costs gigabytes. So an Open/Backlog task that may still be run
  // keeps its whole checkout; anything else (a finished or deleted task,
  // or no task record at all) loses the checkout and keeps the branch.
  // 2026-09-24: a machine updated from an old version had 1000+ such
  // checkouts, every one refused with an error line, one git call each,
  // all before the backend could listen.
  const unmerged = branch.startsWith('lattice/')
    ? await isUnmerged(deps, repoRoot, wt.branch!, unmergedRefs)
    : false;
  if (unmerged) {
    const owner = owners.get(normalizeCwd(resolved));
    if (owner && RERUNNABLE_STATUSES.has(owner.status)) {
      return { kind: 'skipped-rerunnable', branch };
    }
  }
  // `worktree remove --force` would also silently discard uncommitted
  // edits. Archive them to ~/.lattice/snapshots/ (a keep-for-the-user
  // copy that boot recovery never auto-restores); if that fails, the
  // orphan is left in place for the next boot or a human.
  // An interrupted add never reached an agent; its files all read as
  // untracked, so archiving would copy the whole checkout (6.4 GB once).
  const archive = deps.archiveUncommitted ?? archiveUncommittedWorktreeChanges;
  const archived = interruptedAdd
    ? { status: 'clean' as const }
    : await archive(repoRoot, resolved, branch);
  if (archived.status === 'failed') {
    console.error(
      `[startup] sweep: NOT reclaiming ${resolved} — could not archive its uncommitted changes ` +
        `(${archived.error}); leaving the checkout in place`,
    );
    return { kind: 'archive-failed' };
  }
  if (archived.status === 'archived') {
    console.warn(`[startup] sweep: archived ${archived.files} uncommitted change(s) from ${resolved} to ${archived.dir}`);
  }
  // cleanupWorktreeForTask skips the branch delete for non-`lattice/`
  // names, so passing '' (detached) or a stray branch is safe. Already
  // archived above — don't take a second, identical archive.
  let keptBranch: string | undefined;
  const cleaned = await deps.cleanupWorktreeForTask(repoRoot, resolved, branch, undefined, {
    skipArchive: true,
    keepBranchIfUnmerged: true,
    onBranchKept: (info) => { keptBranch = info.name; },
  });
  return { kind: cleaned ? 'removed' : 'kept', keptBranch };
}

function logSweepSummary(
  repoRoot: string,
  removed: number,
  keptBranches: string[],
  skippedRerunnable: string[],
): void {
  if (keptBranches.length > 0) {
    console.warn(
      `[startup] sweep: ${repoRoot}: removed the checkouts of ${keptBranches.length} orphaned worktree(s) but KEPT ` +
        `their lattice/* branches, which hold commits not on HEAD (${describeBranches(keptBranches)}). ` +
        'List them with: git branch --list "lattice/*" --no-merged — delete the ones you no longer want.',
    );
  }
  if (skippedRerunnable.length > 0) {
    console.warn(
      `[startup] sweep: ${repoRoot}: left ${skippedRerunnable.length} worktree(s) of Open/Backlog tasks alone — ` +
        `their branches hold unmerged commits (${describeBranches(skippedRerunnable)})`,
    );
  }

  // Exact cleanup handles missing orphan directories too. Do not globally
  // prune: active or user-managed checkouts may just be temporarily offline.
  if (removed > 0) {
    console.log(`[startup] sweep: reclaimed ${removed} orphaned worktree(s) in ${repoRoot}`);
  }
}

// Worktree path → the task that records it (any status).
function worktreeOwners(tasks: Task[]): Map<string, Task> {
  const out = new Map<string, Task>();
  for (const t of tasks) if (t.worktreePath) out.set(normalizeCwd(t.worktreePath), t);
  return out;
}

// Every `lattice/*` branch with commits not reachable from HEAD, in ONE git
// call (a per-branch `rev-list --count` was 1000+ spawns on a big board).
// null when the listing fails — callers then check branch by branch.
async function listUnmergedLatticeRefs(deps: WorktreeSweepDeps, repoRoot: string): Promise<Set<string> | null> {
  const r = await deps.projectGit(repoRoot, [
    'for-each-ref', '--no-merged=HEAD', '--format=%(refname)', 'refs/heads/lattice/',
  ]);
  if (r.code !== 0) return null;
  return new Set(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('refs/heads/lattice/')));
}

// Fails closed: a branch whose state can't be read counts as unmerged.
async function isUnmerged(
  deps: WorktreeSweepDeps,
  repoRoot: string,
  ref: string,
  unmergedRefs: Set<string> | null,
): Promise<boolean> {
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  if (unmergedRefs) return unmergedRefs.has(full);
  const r = await deps.projectGit(repoRoot, ['rev-list', '--count', `HEAD..${full}`]);
  const count = r.code === 0 ? parseInt(r.stdout.trim(), 10) : NaN;
  return !Number.isFinite(count) || count > 0;
}

function describeBranches(names: string[]): string {
  const shown = names.slice(0, LOGGED_BRANCHES_MAX).join(', ');
  return names.length > LOGGED_BRANCHES_MAX ? `${shown}, … +${names.length - LOGGED_BRANCHES_MAX} more` : shown;
}

function getActiveWorktreePaths(tasks: Task[]): Set<string> {
  return new Set(
    tasks
      .filter((t) => (ACTIVE_STATUSES.has(t.status) || t.runQueued) && t.worktreePath)
      .map((t) => normalizeCwd(t.worktreePath as string)),
  );
}
