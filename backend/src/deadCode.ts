// Dead-code query: a small, agent-friendly view over the health analyzer's
// reachability pass. The full classification lives on each scan node's
// `healthDetails.deadCode` (see `health/crossFile/`); this module distils it
// to just "which files are confidently unreachable" for the
// `GET /api/health/dead-code` endpoint and the conditional note Lattice
// injects into `LATTICE_TASK.md`.
//
// Note on the confidence guard: when the analyzer's resolver looks unreliable
// for a project (>70% of analyzable files come back dead), `crossFile/graph.ts`
// downgrades every `dead` to `uncertain`, so `files` here comes back empty.
// That's intentional — we only ever report files we're reasonably sure about,
// which is exactly the gate the instruction note wants.

import path from 'node:path';
import { scan } from './scanner.js';
import { canonicalProjectPath } from './projectPath.js';

export type DeadCodeFile = {
  // Project-relative, forward-slash path (stable across OSes, easy to paste).
  path: string;
  ext: string;
};

export type DeadCodeSummary = {
  files: DeadCodeFile[];
  total: number;
  // Epoch ms of the scan the summary was derived from.
  scannedAt: number;
};

// Coalesce concurrent / rapid requests onto one in-flight (or recent) scan.
// "Run All" spawns N worktrees at once, each of which wants the dead-code
// summary for the same project — without this they'd each kick off a full
// scan. The promise (not just the value) is memoized so simultaneous callers
// share the single in-flight scan.
const MEMO_TTL_MS = 60_000;
const memo = new Map<string, { at: number; promise: Promise<DeadCodeSummary> }>();

function toRelForward(root: string, abs: string): string {
  const rel = path.relative(root, abs) || path.basename(abs);
  return rel.split(path.sep).join('/');
}

async function computeDeadCodeSummary(absRoot: string): Promise<DeadCodeSummary> {
  const result = await scan(absRoot);
  const files: DeadCodeFile[] = [];
  for (const node of result.nodes) {
    if (node.kind !== 'file') continue;
    if (node.healthDetails?.deadCode === 'dead') {
      files.push({ path: toRelForward(result.root, node.path), ext: node.ext ?? '' });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, total: files.length, scannedAt: Date.now() };
}

export async function getDeadCodeSummary(
  projectRoot: string,
  opts: { force?: boolean } = {},
): Promise<DeadCodeSummary> {
  const abs = canonicalProjectPath(projectRoot);
  const now = Date.now();
  const cached = memo.get(abs);
  if (!opts.force && cached && now - cached.at < MEMO_TTL_MS) {
    return cached.promise;
  }
  const promise = computeDeadCodeSummary(abs);
  memo.set(abs, { at: now, promise });
  // A failed scan shouldn't poison the memo for a full TTL — drop it so the
  // next caller retries.
  promise.catch(() => {
    if (memo.get(abs)?.promise === promise) memo.delete(abs);
  });
  return promise;
}

// Best-effort variant for the worktree-setup path: never throws, and gives up
// after `timeoutMs` so a slow scan on a large project can't stall the Run
// button. A null result simply means "don't inject the dead-code note".
export async function getDeadCodeSummarySafe(
  projectRoot: string,
  timeoutMs = 8000,
): Promise<DeadCodeSummary | null> {
  try {
    const timeout = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      t.unref();
    });
    return await Promise.race([getDeadCodeSummary(projectRoot), timeout]);
  } catch {
    return null;
  }
}
