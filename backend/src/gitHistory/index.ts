// Git-history endpoint backing the timeline scrubber. We shell out to
// `git log` once per request with `--name-status` so the frontend gets
// commits and their changed-file lists in a single round trip; the
// scrubber can then derive the per-range change map purely client-side
// without re-hitting the backend on every drag.

import path from 'node:path';
import { exec } from '../worktree/exec.js';
import { gitLogFormat, parseGitLogNameStatus } from './parseLog.js';
import { parseGitStatusPorcelain } from './parseStatus.js';
import type { GitCommit, GitHistoryResult, GitUncommitted } from './types.js';

export type {
  GitCommit,
  GitCommitChange,
  GitFileStatus,
  GitHistoryResult,
  GitUncommitted,
} from './types.js';

// Per-invocation git timeouts. `git log --name-status` does the most work
// (walks history + diffs each commit) so it gets the longest budget.
const GIT_REVPARSE_TIMEOUT_MS = 4000;
const GIT_LOG_TIMEOUT_MS = 6000;
const GIT_STATUS_TIMEOUT_MS = 4000;

function clampLogLimit(limit: number): number {
  return Math.max(1, Math.min(50, Math.floor(limit)));
}

async function isGitRepo(repoRoot: string): Promise<boolean> {
  const r = await exec('git', ['rev-parse', '--is-inside-work-tree'], repoRoot, {
    timeoutMs: GIT_REVPARSE_TIMEOUT_MS,
  });
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function readCommits(repoRoot: string, limit: number): Promise<GitCommit[]> {
  // `--format` emits one header line per commit (with the parser's
  // sentinels), followed by the name-status block, terminated with a blank
  // line. Staying line-oriented is simpler and plenty fast for ~10 commits.
  const r = await exec(
    'git',
    [
      // core.quotePath=false makes git emit non-ASCII paths (accented/CJK
      // filenames) literally as UTF-8 instead of C-quoting them (e.g.
      // `"na\303\257ve.ts"`). Without it those paths reach the parser
      // double-quoted + octal-escaped and never match the graph's
      // file-node id, so the commit's change-ring silently vanishes. The
      // status path already disables quoting via `git status -z`; this is
      // the matching fix for the log path (the `-c <name=value>` global
      // option must precede the `log` subcommand).
      '-c',
      'core.quotePath=false',
      'log',
      `-${clampLogLimit(limit)}`,
      '--no-merges',
      '--name-status',
      // -M turns on rename detection so renamed files surface as `R…`
      // entries (which we decompose into delete + add); without it git
      // emits add/delete pairs instead, which is fine — we just lose the
      // oldPath linkage. `--no-renames=false` is invalid syntax.
      '-M',
      `--format=${gitLogFormat()}`,
    ],
    repoRoot,
    { timeoutMs: GIT_LOG_TIMEOUT_MS },
  );
  if (r.code !== 0) {
    // No commits yet, shallow repo with no history, etc. — return empty.
    return [];
  }

  return parseGitLogNameStatus(r.stdout);
}

async function readUncommitted(repoRoot: string): Promise<GitUncommitted> {
  const r = await exec('git', ['status', '--porcelain=v1', '-z'], repoRoot, {
    timeoutMs: GIT_STATUS_TIMEOUT_MS,
  });
  if (r.code !== 0) return { changes: [] };

  return parseGitStatusPorcelain(r.stdout);
}

export async function getGitHistory(
  repoRoot: string,
  limit: number,
): Promise<GitHistoryResult> {
  const abs = path.resolve(repoRoot);
  if (!(await isGitRepo(abs))) {
    return { isRepo: false, commits: [], uncommitted: { changes: [] } };
  }
  // Fetch in parallel — they're independent git invocations.
  const [commits, uncommitted] = await Promise.all([
    readCommits(abs, limit),
    readUncommitted(abs),
  ]);
  return { isRepo: true, commits, uncommitted };
}
