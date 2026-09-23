// The Run tests step's result text, stored on the run as
// `run.stepSummaries[stepIndex]` when the step advances (any path: the agent
// finished, it was skipped, it could not start, it timed out, its terminal was
// lost). Three parts, each optional:
//   1. Lattice's own notes (why it was skipped / what went wrong);
//   2. the agent's TEST_SUMMARY.md, bounded;
//   3. the post-check: the commits the step made, and a warning for any that
//      touched a path on USER_WIP.txt (the user's work in progress).
// Informational only — nothing here changes the repo or stops the workflow.

import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_SUMMARY_FILENAME } from './brief.js';
import { wipCovers } from './userWip.js';
import type { StepCommit } from './checkoutGit.js';

export const TEST_SUMMARY_MAX_BYTES = 8 * 1024;
// The whole stored summary (notes + report + post-check) is capped too: it
// rides every run snapshot over the WS and into workflow-runs.json.
export const STEP_SUMMARY_MAX_CHARS = 12_000;
const POST_CHECK_COMMITS_SHOWN = 20;

// Read TEST_SUMMARY.md from the step dir, at most TEST_SUMMARY_MAX_BYTES.
// null when the agent never wrote one.
export async function readTestSummaryFile(stepDir: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.join(stepDir, TEST_SUMMARY_FILENAME), 'r');
    const buf = Buffer.alloc(TEST_SUMMARY_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const truncated = bytesRead > TEST_SUMMARY_MAX_BYTES;
    // Cut on a byte budget, then drop a partial trailing UTF-8 sequence.
    const text = buf.subarray(0, Math.min(bytesRead, TEST_SUMMARY_MAX_BYTES)).toString('utf8').replace(/�+$/, '');
    return truncated ? `${text.trimEnd()}\n\n_(truncated — the full report is ${path.join(stepDir, TEST_SUMMARY_FILENAME)})_` : text.trim();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The post-check block: the step's commits and any that touched the user's WIP.
export function renderPostCheck(commits: readonly StepCommit[] | null, wip: readonly string[] | null): string {
  if (commits === null) return '';
  if (commits.length === 0) return '**Commits by this step:** none.';
  const lines = [`**Commits by this step (${commits.length}):**`];
  for (const c of commits.slice(0, POST_CHECK_COMMITS_SHOWN)) lines.push(`- \`${c.sha}\` ${c.subject}`);
  if (commits.length > POST_CHECK_COMMITS_SHOWN) lines.push(`- … and ${commits.length - POST_CHECK_COMMITS_SHOWN} more`);
  if (wip && wip.length > 0) {
    const touched = new Map<string, string[]>();
    for (const c of commits) {
      for (const f of c.files) {
        if (!wipCovers(wip, f)) continue;
        const list = touched.get(f) ?? [];
        list.push(c.sha);
        touched.set(f, list);
      }
    }
    if (touched.size > 0) {
      lines.push('', `**Warning — ${touched.size} committed path(s) were part of your uncommitted work when the step started** (check these commits):`);
      for (const [file, shas] of [...touched].slice(0, 30)) lines.push(`- \`${file}\` (${shas.join(', ')})`);
      if (touched.size > 30) lines.push(`- … and ${touched.size - 30} more`);
    }
  }
  return lines.join('\n');
}

export function composeStepSummary(parts: {
  notes: readonly string[];
  report: string | null;
  reportExpected: boolean;
  postCheck: string;
}): string {
  const sections: string[] = [];
  if (parts.notes.length) sections.push(parts.notes.map((n) => `> ${n}`).join('\n>\n'));
  if (parts.report) sections.push(parts.report);
  else if (parts.reportExpected) sections.push(`_The agent did not write ${TEST_SUMMARY_FILENAME}._`);
  if (parts.postCheck) sections.push(parts.postCheck);
  const text = sections.join('\n\n').trim();
  return text.length > STEP_SUMMARY_MAX_CHARS ? `${text.slice(0, STEP_SUMMARY_MAX_CHARS - 1)}…` : text;
}
