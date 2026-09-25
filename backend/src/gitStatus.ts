// Live "the git status changed" signal for the active project's timeline
// scrubber. The scrubber's commit list + uncommitted-changes view is fetched
// once per project via /api/git-history; without this it stays stale until a
// full page refresh — so after you commit it still shows the old dirty state,
// and a fresh edit doesn't light up as dirty (the two bugs this fixes).
//
// On any relevant filesystem change we recompute a compact status signature
// (HEAD + dirty set — see gitHistory/signature.ts) and wake subscribers ONLY
// when it actually changed, so noise (a gitignored file that slipped the filter,
// a `git status` index-stat refresh) never spams clients. We watch two things:
//
//   1. The repo's git metadata dir (HEAD / index / logs / refs / *_HEAD /
//      packed-refs), minus the heavy `objects`/`lfs` subtrees — the precise,
//      cheap signal for a commit / stage / checkout / merge / reset.
//   2. The working tree (gitignore-aware, `.git` excluded) — so an unstaged
//      edit that dirties the tree, or reverting it clean, is caught too.
//
// Like gitBranch.ts these are READ-ONLY watchers: they never write or delete,
// so they are irrelevant to the `.git`-deletion defences. Both go through
// watchTree so that on Windows a single recursive handle covers each tree —
// chokidar's per-directory handles would otherwise pin `.git/worktrees/<name>/`
// and every project subdirectory against rename/delete (see watchTree.ts). It is
// event-driven — no polling / continuous scanning; a single fast `git status`
// runs only when a watched path actually changes, and only after a debounce.

import type { Stats } from 'node:fs';
import path from 'node:path';
import type { Ignore } from 'ignore';
import { watchTree, type TreeWatcher } from './watchTree.js';
import { computeStatusSignature } from './gitHistory/signature.js';
import { resolveGitDir } from './gitDir.js';
import { loadGitignore } from './scanner/ignore.js';
import { matchIgnoredSourcePath } from './health/constants.js';
import {
  createProjectWatcherRegistry,
  publishIfChanged,
  type ProjectWatcherSlot,
} from './gitWatcherRegistry.js';

// Coalesce the burst of events a single git op emits (a `commit` touches index,
// logs/HEAD, and a ref in quick succession; a save-all touches many files) into
// one signature recomputation.
const RECOMPUTE_DEBOUNCE_MS = 250;

export type GitStatusListener = (signature: string) => void;

type GitStatusWatcher = ProjectWatcherSlot<string> & {
  watchers: TreeWatcher[];
};

const LOG_LABEL = '[git-status watcher]';

// The shared per-root registry (gitWatcherRegistry.ts, same as gitBranch.ts):
// concurrent first subscriptions for one root share a single build, kept for
// the life of the process — a WS reconnect storm would otherwise churn the
// watchers on every drop, and a couple of watchers per opened project is cheap.
const registry = createProjectWatcherRegistry<GitStatusWatcher, string>({
  label: LOG_LABEL,
  create: createGitStatusWatcher,
  arm: armGitStatusWatchers,
  compute: computeStatusSignature,
  close: async (proj) => {
    await Promise.all(proj.watchers.map((w) => w.close()));
  },
});

async function createGitStatusWatcher(root: string): Promise<GitStatusWatcher> {
  const proj: GitStatusWatcher = {
    root,
    watchers: [],
    subscribers: new Set(),
    current: await computeStatusSignature(root),
  };
  await armGitStatusWatchers(proj);
  return proj;
}

// A debounced trigger that recomputes the signature and fans out only on a real
// change. Serialized: a change arriving mid-recompute sets `pending` so we run
// exactly once more afterward (never two overlapping `git status` calls, never
// a missed change).
function createDebouncedRecompute(proj: GitStatusWatcher): () => void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;

  const runRecompute = async (): Promise<void> => {
    running = true;
    try {
      publishIfChanged(LOG_LABEL, proj, await computeStatusSignature(proj.root));
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void runRecompute().catch(() => {});
      }
    }
  };

  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (running) {
        pending = true;
        return;
      }
      void runRecompute().catch(() => {});
    }, RECOMPUTE_DEBOUNCE_MS);
  };
}

// The working-tree filter's matcher. Reloaded when the ROOT `.gitignore`
// changes (see `armGitStatusWatchers`' `onTreeEvent`): with a matcher frozen at
// subscribe time, un-ignoring a directory left every later edit under it
// filtered out, so the scrubber never lit up the files git had just started
// reporting. `onReloaded` runs once a reload has published its new rules.
async function createGitignoreMatcher(
  root: string,
  onReloaded: () => void,
): Promise<{ current: () => Ignore; reload: () => Promise<void> }> {
  let gitignore = await loadGitignore(root);
  let gitignoreRevision = 0;
  const reload = async (): Promise<void> => {
    const revision = ++gitignoreRevision;
    const next = await loadGitignore(root);
    // Only the newest reload may publish (two quick saves, reads out of order).
    if (revision !== gitignoreRevision) return;
    gitignore = next;
    onReloaded();
  };
  return { current: () => gitignore, reload };
}

// Route every change event of each watcher to its handler. Without an 'error'
// listener the watcher re-emits into the void, which Node treats as an
// unhandled exception and crashes the process. Log and swallow.
function wireTreeWatchers(
  pairs: ReadonlyArray<readonly [TreeWatcher, (p: string) => void]>,
): void {
  for (const [w, handler] of pairs) {
    w.on('error', (err) => console.error(LOG_LABEL, err));
    w.on('add', handler);
    w.on('change', handler);
    w.on('unlink', handler);
    w.on('addDir', handler);
    w.on('unlinkDir', handler);
  }
}

// Attach both trees. Split out of `createGitStatusWatcher` so
// `rearmGitStatusWatcher` can run it a second time on a watcher that was built
// before the folder had a `.git` at all.
async function armGitStatusWatchers(proj: GitStatusWatcher): Promise<void> {
  if (proj.watchers.length > 0) return;
  const root = proj.root;

  const gitDir = await resolveGitDir(root);
  if (!gitDir) return; // not a git repo — nothing to watch

  const recompute = createDebouncedRecompute(proj);

  // On a reload, re-cover the tree under the new rules: chokidar never
  // descended into a previously-ignored directory, and the recursive backend
  // re-diffs it (diff-based, so only real differences are reported).
  const gitignore = await createGitignoreMatcher(root, () => treeWatcher.add(root));
  const rootGitignore = path.join(root, '.gitignore');

  // 1. Git metadata: watch the whole git dir but prune the heavy content-object
  //    subtrees (a commit writes many loose objects we don't care about).
  const objectsDir = path.join(gitDir, 'objects');
  const lfsDir = path.join(gitDir, 'lfs');
  const underDir = (p: string, dir: string) =>
    p === dir || p.startsWith(dir + path.sep);
  const metaWatcher = watchTree(gitDir, {
    ignored: (p: string) => underDir(p, objectsDir) || underDir(p, lfsDir),
  });

  // 2. Working tree: gitignore-aware so build outputs / vendored dirs don't fire
  //    (they never affect `git status`). `.git` is pruned by IGNORE_DIR_NAMES
  //    inside matchIgnoredSourcePath, so this watcher never double-covers (1).
  const treeWatcher = watchTree(root, {
    ignored: (p: string, stats?: Stats) =>
      matchIgnoredSourcePath(p, root, gitignore.current(), stats?.isDirectory() ?? false),
  });

  const onTreeEvent = (p: string) => {
    if (path.resolve(p) === rootGitignore) void gitignore.reload().catch(() => {});
    recompute();
  };

  wireTreeWatchers([
    [metaWatcher, recompute],
    [treeWatcher, onTreeEvent],
  ]);
  proj.watchers = [metaWatcher, treeWatcher];
}

// A folder that wasn't a repo when the first client subscribed got no watchers
// at all — so after `git init` the timeline scrubber would never hear about a
// commit until a page reload. `initProjectGit` calls this on success.
// Best-effort, exactly like `rearmGitBranchWatcher`.
export async function rearmGitStatusWatcher(projectRoot: string): Promise<void> {
  await registry.rearm(projectRoot);
}

// Subscribe to the active project's git-status signature. The current value is
// delivered right after the watcher resolves (like subscribeGitBranch) so a
// freshly-(re)connected client re-syncs: the frontend dedupes it against the
// signature it already fetched from /api/git-history, so a matching value is a
// no-op while a value that changed during a disconnect triggers a catch-up
// refresh. Every subsequent real change re-invokes the callback.
export async function subscribeGitStatus(
  projectRoot: string,
  cb: GitStatusListener,
): Promise<() => void> {
  return registry.subscribe(projectRoot, cb);
}

// Test-only: close every watcher and clear the map so suites don't leak
// persistent chokidar FSWatchers across tests.
export async function _resetGitStatusWatchersForTest(): Promise<void> {
  await registry.resetForTest();
}
