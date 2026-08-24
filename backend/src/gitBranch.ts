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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { exec } from './worktree/exec.js';
import { canonicalProjectPath } from './projectPath.js';

const GIT_BRANCH_TIMEOUT_MS = 4000;
// Coalesce the burst of filesystem events a single checkout can emit (git
// writes HEAD.lock then renames it over HEAD, which surfaces as unlink+add on
// some platforms) into one branch re-derivation.
const RECOMPUTE_DEBOUNCE_MS = 150;

// Current branch of a repo's working tree. `rev-parse --abbrev-ref HEAD` yields
// the branch name, or the literal "HEAD" when detached — in which case we
// surface the short sha so the navbar shows something meaningful instead of a
// bare "HEAD". Returns null when the folder isn't a git repo (or git isn't
// available), so the navbar can just omit the branch indicator.
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const r = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const name = r.stdout.trim();
    if (r.code !== 0 || !name) return null;
    if (name !== 'HEAD') return name;
    const sha = await exec('git', ['rev-parse', '--short', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const short = sha.stdout.trim();
    return short ? `detached @ ${short}` : null;
  } catch {
    return null;
  }
}

export type BranchListener = (branch: string | null) => void;

type BranchWatcher = {
  root: string;
  watcher: FSWatcher | null;
  subscribers: Set<BranchListener>;
  current: string | null;
};

// Keyed by the in-flight (or settled) creation promise so concurrent first
// subscriptions for one root share a single watcher (mirrors health/watcher.ts).
// Watchers are kept for the life of the process: a WS reconnect storm would
// otherwise churn (close+recreate) the chokidar watcher on every drop, and a
// single-file watcher per opened project is cheap. Bounded by the number of
// distinct project roots opened in a session.
const watchers = new Map<string, Promise<BranchWatcher>>();

// Resolve the HEAD file to watch. For a normal repo `<root>/.git` is a
// directory and HEAD lives directly inside it. For a linked worktree /
// submodule `.git` is a file (`gitdir: <path>`) pointing at the real git dir,
// whose own HEAD tracks that checkout's branch. Returns null when the folder
// isn't a git repo.
async function resolveHeadFile(repoRoot: string): Promise<string | null> {
  const dotGit = path.join(repoRoot, '.git');
  try {
    const st = await fs.stat(dotGit);
    if (st.isDirectory()) return path.join(dotGit, 'HEAD');
    const content = await fs.readFile(dotGit, 'utf8');
    const m = content.match(/^gitdir:\s*(.+)\s*$/m);
    if (!m) return null;
    const raw = m[1].trim();
    const gitdir = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
    return path.join(gitdir, 'HEAD');
  } catch {
    return null;
  }
}

function ensureBranchWatcher(root: string): Promise<BranchWatcher> {
  const existing = watchers.get(root);
  if (existing) return existing;
  const creation = createBranchWatcher(root);
  watchers.set(root, creation);
  // A failed build must not poison the slot forever — drop it so the next
  // subscriber retries from scratch.
  creation.catch(() => {
    if (watchers.get(root) === creation) watchers.delete(root);
  });
  return creation;
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
        const branch = await getCurrentBranch(root);
        if (branch === proj.current) return; // unchanged — don't wake clients
        proj.current = branch;
        for (const cb of [...proj.subscribers]) cb(branch);
      })();
    }, RECOMPUTE_DEBOUNCE_MS);
  };

  const watcher = chokidar.watch(headFile, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  // Without an 'error' listener chokidar re-emits into the void, which Node
  // treats as an unhandled exception and crashes the process. Log and swallow.
  watcher.on('error', (err) => console.error('[git-branch watcher]', err));
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
  const root = canonicalProjectPath(projectRoot);
  const pending = watchers.get(root);
  if (!pending) return;
  let proj: BranchWatcher;
  try {
    proj = await pending;
  } catch {
    return;
  }
  await armBranchWatcher(proj);
  const branch = await getCurrentBranch(root);
  if (branch === proj.current) return;
  proj.current = branch;
  for (const cb of [...proj.subscribers]) cb(branch);
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
  const root = canonicalProjectPath(projectRoot);
  const proj = await ensureBranchWatcher(root);
  proj.subscribers.add(cb);
  cb(proj.current);
  return () => {
    proj.subscribers.delete(cb);
  };
}

// Test-only: number of branch watchers currently tracked (incl. in-flight
// builds).
export function _branchWatcherCountForTest(): number {
  return watchers.size;
}

// Test-only: close every watcher and clear the map so suites don't leak
// persistent chokidar FSWatchers across tests.
export async function _resetBranchWatchersForTest(): Promise<void> {
  const pending = [...watchers.values()];
  watchers.clear();
  await Promise.all(
    pending.map(async (p) => {
      try {
        const proj = await p;
        await proj.watcher?.close();
      } catch {
        /* build failed or already closed */
      }
    }),
  );
}
