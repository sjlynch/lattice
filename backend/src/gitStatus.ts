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
// Like gitBranch.ts this is a READ-ONLY chokidar watcher: it never writes or
// deletes, so it is irrelevant to the `.git`-deletion defences. It is
// event-driven — no polling / continuous scanning; a single fast `git status`
// runs only when a watched path actually changes, and only after a debounce.

import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { canonicalProjectPath } from './projectPath.js';
import { computeStatusSignature } from './gitHistory/signature.js';
import { loadGitignore } from './scanner/ignore.js';
import { matchIgnoredSourcePath } from './health/constants.js';

// Coalesce the burst of events a single git op emits (a `commit` touches index,
// logs/HEAD, and a ref in quick succession; a save-all touches many files) into
// one signature recomputation.
const RECOMPUTE_DEBOUNCE_MS = 250;

export type GitStatusListener = (signature: string) => void;

type GitStatusWatcher = {
  root: string;
  watchers: FSWatcher[];
  subscribers: Set<GitStatusListener>;
  current: string;
};

// Keyed by the in-flight (or settled) creation promise so concurrent first
// subscriptions for one root share a single watcher (mirrors gitBranch.ts /
// health/watcher.ts). Kept for the life of the process: a WS reconnect storm
// would otherwise churn the chokidar watchers on every drop, and a couple of
// watchers per opened project is cheap.
const watchers = new Map<string, Promise<GitStatusWatcher>>();

// Resolve the repo's git metadata directory. For a normal repo that's
// `<root>/.git`; for a linked worktree / submodule `.git` is a FILE
// (`gitdir: <path>`) pointing at the real git dir, whose HEAD/index/logs track
// that checkout. Returns null when the folder isn't a git repo.
async function resolveGitDir(repoRoot: string): Promise<string | null> {
  const dotGit = path.join(repoRoot, '.git');
  try {
    const st = await fs.stat(dotGit);
    if (st.isDirectory()) return dotGit;
    const content = await fs.readFile(dotGit, 'utf8');
    const m = content.match(/^gitdir:\s*(.+)\s*$/m);
    if (!m) return null;
    const raw = m[1].trim();
    return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  } catch {
    return null;
  }
}

function ensureGitStatusWatcher(root: string): Promise<GitStatusWatcher> {
  const existing = watchers.get(root);
  if (existing) return existing;
  const creation = createGitStatusWatcher(root);
  watchers.set(root, creation);
  // A failed build must not poison the slot forever — drop it so the next
  // subscriber retries from scratch.
  creation.catch(() => {
    if (watchers.get(root) === creation) watchers.delete(root);
  });
  return creation;
}

async function createGitStatusWatcher(root: string): Promise<GitStatusWatcher> {
  const proj: GitStatusWatcher = {
    root,
    watchers: [],
    subscribers: new Set(),
    current: await computeStatusSignature(root),
  };

  const gitDir = await resolveGitDir(root);
  if (!gitDir) return proj; // not a git repo — nothing to watch

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;

  // Recompute the signature and fan out only on a real change. Serialized: a
  // change arriving mid-recompute sets `pending` so we run exactly once more
  // afterward (never two overlapping `git status` calls, never a missed change).
  const runRecompute = async (): Promise<void> => {
    running = true;
    try {
      const sig = await computeStatusSignature(root);
      if (sig !== proj.current) {
        proj.current = sig;
        for (const cb of [...proj.subscribers]) cb(sig);
      }
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void runRecompute().catch(() => {});
      }
    }
  };

  const recompute = () => {
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

  const gitignore = await loadGitignore(root);

  // 1. Git metadata: watch the whole git dir but prune the heavy content-object
  //    subtrees (a commit writes many loose objects we don't care about).
  const objectsDir = path.join(gitDir, 'objects');
  const lfsDir = path.join(gitDir, 'lfs');
  const underDir = (p: string, dir: string) =>
    p === dir || p.startsWith(dir + path.sep);
  const metaWatcher = chokidar.watch(gitDir, {
    ignored: (p: string) => underDir(p, objectsDir) || underDir(p, lfsDir),
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  // 2. Working tree: gitignore-aware so build outputs / vendored dirs don't fire
  //    (they never affect `git status`). `.git` is pruned by IGNORE_DIR_NAMES
  //    inside matchIgnoredSourcePath, so this watcher never double-covers (1).
  const treeWatcher = chokidar.watch(root, {
    ignored: (p: string, stats?: Stats) =>
      matchIgnoredSourcePath(p, root, gitignore, stats?.isDirectory() ?? false),
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  for (const w of [metaWatcher, treeWatcher]) {
    // Without an 'error' listener chokidar re-emits into the void, which Node
    // treats as an unhandled exception and crashes the process. Log and swallow.
    w.on('error', (err) => console.error('[git-status watcher]', err));
    w.on('add', recompute);
    w.on('change', recompute);
    w.on('unlink', recompute);
    w.on('addDir', recompute);
    w.on('unlinkDir', recompute);
  }
  proj.watchers = [metaWatcher, treeWatcher];
  return proj;
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
  const root = canonicalProjectPath(projectRoot);
  const proj = await ensureGitStatusWatcher(root);
  proj.subscribers.add(cb);
  cb(proj.current);
  return () => {
    proj.subscribers.delete(cb);
  };
}

// Test-only: number of git-status watchers currently tracked (incl. in-flight
// builds).
export function _gitStatusWatcherCountForTest(): number {
  return watchers.size;
}

// Test-only: close every watcher and clear the map so suites don't leak
// persistent chokidar FSWatchers across tests.
export async function _resetGitStatusWatchersForTest(): Promise<void> {
  const pending = [...watchers.values()];
  watchers.clear();
  await Promise.all(
    pending.map(async (p) => {
      try {
        const proj = await p;
        await Promise.all(proj.watchers.map((w) => w.close()));
      } catch {
        /* build failed or already closed */
      }
    }),
  );
}
