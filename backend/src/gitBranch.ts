// Current git branch of a project's working tree (the label shown in the
// navbar) plus a live watcher that re-derives it whenever the branch changes.
//
// The branch only moves when someone checks out a different branch (or detaches
// HEAD) — a plain `git commit` advances the branch ref, not HEAD, so it does
// NOT change `.git/HEAD`. Watching that one file therefore gives us a precise,
// low-noise "the branch changed" signal that fires the moment a terminal (a
// Claude console, or the user) runs `git checkout`, so the navbar chip updates
// without a page refresh.
//
// This is a READ-ONLY file watcher: chokidar never writes or deletes, so it is
// irrelevant to the `.git`-deletion defences documented across the worktree
// subsystem.

import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { exec } from './worktree/exec.js';
import { resolveGitDir } from './gitDir.js';
import {
  createProjectWatcherRegistry,
  publishIfChanged,
  type ProjectWatcherSlot,
} from './gitWatcherRegistry.js';

const GIT_BRANCH_TIMEOUT_MS = 4000;
// Coalesce the burst of filesystem events a single checkout can emit (git
// writes HEAD.lock then renames it over HEAD, which surfaces as unlink+add on
// some platforms) into one branch re-derivation.
const RECOMPUTE_DEBOUNCE_MS = 150;

// Current branch of a repo's working tree. `symbolic-ref --short HEAD` yields
// the branch name whenever HEAD points at a branch — INCLUDING an "unborn"
// branch in a repo with no commits yet, which is what a freshly initialized
// project is (and what a project whose first commit failed for a missing git
// identity stays). `rev-parse --abbrev-ref HEAD` cannot resolve that (HEAD is
// not a commit), so the navbar chip used to vanish for exactly the projects a
// user had just created. Detached HEAD fails `symbolic-ref`; then we surface
// the short sha so the chip shows something meaningful instead of a bare
// "HEAD". Returns null when the folder isn't a git repo (or git isn't
// available), so the navbar can just omit the branch indicator.
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const ref = await exec('git', ['symbolic-ref', '--short', '-q', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const name = ref.stdout.trim();
    if (ref.code === 0 && name) return name;
    // Not a symbolic ref: detached, or not a repo at all. Only a detached HEAD
    // resolves to a commit.
    const sha = await exec('git', ['rev-parse', '--short', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const short = sha.stdout.trim();
    return sha.code === 0 && short ? `detached @ ${short}` : null;
  } catch {
    return null;
  }
}

export type BranchListener = (branch: string | null) => void;

type BranchWatcher = ProjectWatcherSlot<string | null> & {
  watcher: FSWatcher | null;
};

const LOG_LABEL = '[git-branch watcher]';

// Chokidar holds an event until HEAD's size has been stable this long (git
// writes HEAD.lock then renames it over HEAD), polling at this interval.
const HEAD_WRITE_STABILITY_THRESHOLD_MS = 100;
const HEAD_WRITE_POLL_INTERVAL_MS = 50;

// The shared per-root registry (gitWatcherRegistry.ts): one watcher per opened
// project, lazily built on first subscription and kept for the life of the
// process.
const registry = createProjectWatcherRegistry<BranchWatcher, string | null>({
  label: LOG_LABEL,
  create: createBranchWatcher,
  arm: armBranchWatcher,
  compute: getCurrentBranch,
  close: async (proj) => {
    await proj.watcher?.close();
  },
});

// Kept here for existing importers; lives in gitDir.ts.
export { resolveGitDir };

async function resolveHeadFile(repoRoot: string): Promise<string | null> {
  const gitDir = await resolveGitDir(repoRoot);
  return gitDir ? path.join(gitDir, 'HEAD') : null;
}

async function createBranchWatcher(root: string): Promise<BranchWatcher> {
  const proj: BranchWatcher = {
    root,
    watcher: null,
    subscribers: new Set(),
    current: await getCurrentBranch(root),
  };
  await armBranchWatcher(proj);
  return proj;
}

// Attach the chokidar watch to the repo's HEAD file. Split out of
// `createBranchWatcher` so `rearmGitBranchWatcher` can run it a second time on
// a watcher that was built before the folder had a `.git` at all.
async function armBranchWatcher(proj: BranchWatcher): Promise<void> {
  if (proj.watcher) return;
  const root = proj.root;
  const headFile = await resolveHeadFile(root);
  if (!headFile) return; // not a git repo — nothing to watch

  let timer: NodeJS.Timeout | null = null;
  const recompute = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        // Wakes clients only when the branch actually changed.
        publishIfChanged(LOG_LABEL, proj, await getCurrentBranch(root));
      })().catch((err) => {
        // A throwing subscriber must not surface as an unhandled rejection —
        // the process guards fail fast on those (gitStatus.ts does the same).
        console.error(LOG_LABEL, err);
      });
    }, RECOMPUTE_DEBOUNCE_MS);
  };

  const watcher = chokidar.watch(headFile, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: HEAD_WRITE_STABILITY_THRESHOLD_MS,
      pollInterval: HEAD_WRITE_POLL_INTERVAL_MS,
    },
  });
  // Without an 'error' listener chokidar re-emits into the void, which Node
  // treats as an unhandled exception and crashes the process. Log and swallow.
  watcher.on('error', (err) => console.error(LOG_LABEL, err));
  watcher.on('add', recompute);
  watcher.on('change', recompute);
  watcher.on('unlink', recompute);
  proj.watcher = watcher;
}

// A folder that wasn't a repo when the first client subscribed got no watcher
// and a permanently null branch — so after `git init` the navbar chip would
// stay blank until a page reload. `initProjectGit` calls this on success.
// Best-effort by design: no subscribers means no watcher to fix (the first
// subscriber will build one against the new repo), and a failed build is left
// for the next subscriber to retry.
export async function rearmGitBranchWatcher(projectRoot: string): Promise<void> {
  await registry.rearm(projectRoot);
}

// Subscribe to the active project's current git branch. The current value is
// delivered synchronously-ish (right after the watcher resolves) so a fresh
// subscriber paints the chip without waiting for the next HEAD change; every
// subsequent branch change re-invokes the callback. The watcher is lazily
// started on first subscription and shared by later subscribers.
export async function subscribeGitBranch(
  projectRoot: string,
  cb: BranchListener,
): Promise<() => void> {
  return registry.subscribe(projectRoot, cb);
}

// Test-only: close every watcher and clear the map so suites don't leak
// persistent chokidar FSWatchers across tests.
export async function _resetBranchWatchersForTest(): Promise<void> {
  await registry.resetForTest();
}
