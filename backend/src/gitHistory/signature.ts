// A compact fingerprint of the exact repo state the timeline scrubber renders:
// the current HEAD commit (so a new/amended commit, checkout, reset, merge, or
// rebase moves it) plus the full set of uncommitted (staged/unstaged/untracked)
// paths (so an edit that dirties the tree — or a commit/checkout that cleans it —
// moves it). `git status --porcelain=v2 --branch -z` yields all of that in a
// single call: the `# branch.oid` header line carries HEAD, and the entry lines
// carry every changed path. We hash the raw output so the value stays small on
// the wire (and in memory) regardless of how dirty the tree is.
//
// Consumed by BOTH the /api/git-history endpoint (returned as `signature`, so the
// frontend can dedupe its re-fetches) and the gitStatus.ts watcher (compared
// between filesystem events to decide whether to wake subscribers). Both run the
// IDENTICAL git command, so their signatures always agree for the same state.

import { createHash } from 'node:crypto';
import { exec } from '../worktree/exec.js';

const GIT_STATUS_SIGNATURE_TIMEOUT_MS = 4000;

export async function computeStatusSignature(repoRoot: string): Promise<string> {
  try {
    const r = await exec(
      'git',
      ['status', '--porcelain=v2', '--branch', '-z'],
      repoRoot,
      { timeoutMs: GIT_STATUS_SIGNATURE_TIMEOUT_MS },
    );
    // Not a repo, a transient failure, etc. → empty signature.
    if (r.code !== 0) return '';
    return createHash('sha1').update(r.stdout).digest('hex');
  } catch {
    // git missing, or the cwd vanished (the project dir was deleted while a
    // watcher recompute was in flight) → spawn rejects. Never propagate: a
    // rejected recompute would surface as an unhandled rejection, and the
    // backend's process guards fail fast on those. Callers treat '' as
    // "unknown"; two empties compare equal so this can't spam change events.
    return '';
  }
}
