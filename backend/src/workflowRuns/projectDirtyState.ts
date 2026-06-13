// Detects whether the project's git working tree has uncommitted changes,
// and renders a warning section for WORKFLOW_STEP.md when it does.
//
// Why this exists: workflow planning steps (e.g. the "Refactor" step that
// audits the codebase and creates tasks) execute in the project tree and
// inspect files there. But every task they spawn runs in a fresh
// `git worktree add` checkout based on HEAD, not on the working tree the
// planner saw. If the user has a large WIP refactor sitting uncommitted,
// the planner's view and the executor's view diverge:
//
//   planner sees: apps/admin/Foo.tsx (newly renamed, only on disk)
//   worktree sees: apps/ui/foo/Foo.ts (still the HEAD path)
//
// The executing agent then reports "this path doesn't exist" — looks
// exactly like a hallucination, but is actually a working-tree mismatch.
// The fix is to tell the planner about the divergence so it can either
// reference HEAD-truth paths or skip planning over the diverged subtree.
//
// See `workflowRuns/CLAUDE.md` for the broader rationale.
//
// The check is best-effort: a non-git project, a status failure, or an
// empty status all resolve to `null` (no warning rendered). Failures are
// logged but never block a workflow run.

import { exec } from '../worktree/exec.js';
import { projectGit } from '../worktree/projectGit.js';

export type DirtyStateSummary = {
  modified: string[]; // tracked changes (any non-D index/worktree status)
  deleted: string[]; // tracked paths removed from worktree (or staged D)
  untracked: string[]; // ?? — new files not yet in the index
};

// Max sample paths to embed in the rendered warning. Keep this small
// enough that a giant WIP refactor (hundreds of paths) doesn't blow up
// the prompt; the warning still names totals so the planner knows the
// real scope.
const MAX_SAMPLE_PATHS = 25;

export async function getProjectDirtyState(
  projectPath: string,
): Promise<DirtyStateSummary | null> {
  // Resolve the repo root via plain exec so a non-git project just
  // returns null instead of throwing through projectGit's `.git` assert.
  const root = await exec('git', ['rev-parse', '--show-toplevel'], projectPath);
  if (root.code !== 0) return null;
  const repoRoot = root.stdout.trim();
  if (!repoRoot) return null;

  let status;
  try {
    status = await projectGit(repoRoot, ['status', '--porcelain=v1', '-uall']);
  } catch (err) {
    console.warn(
      `[workflow-step] dirty-state probe failed for ${repoRoot}: ${(err as Error).message}`,
    );
    return null;
  }
  if (status.code !== 0) return null;

  const modified: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    // Porcelain v1 path field starts at column 3. Renames have the form
    // `R  old -> new`; the new path is what's on disk now, so we keep
    // the whole "old -> new" string in the sample (informative to the
    // planner that this exists in HEAD as `old`).
    const file = line.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
    } else if (x === 'D' || y === 'D') {
      deleted.push(file);
    } else {
      modified.push(file);
    }
  }

  if (!modified.length && !deleted.length && !untracked.length) return null;
  return { modified, deleted, untracked };
}

export function renderDirtyStateWarning(dirty: DirtyStateSummary): string {
  const total = dirty.modified.length + dirty.deleted.length + dirty.untracked.length;
  // Prefer deletions in the sample (these are the most likely to confuse
  // a planner — paths it can't see anywhere but that exist in HEAD), then
  // untracked (new paths the planner sees but worktrees won't), then
  // modifications.
  const labelled: string[] = [
    ...dirty.deleted.map((p) => `D  ${p}`),
    ...dirty.untracked.map((p) => `?? ${p}`),
    ...dirty.modified.map((p) => `M  ${p}`),
  ];
  const sample = labelled.slice(0, MAX_SAMPLE_PATHS);
  const omitted = labelled.length - sample.length;

  return [
    '## ⚠ Project working tree has uncommitted changes — read this before planning',
    '',
    `The project's git working tree has **${dirty.modified.length} modified, ${dirty.deleted.length} deleted, ${dirty.untracked.length} untracked** path(s) (${total} total).`,
    '',
    "**This matters because every task you create runs in a fresh `git worktree add` checkout based on HEAD — not on the working tree you're inspecting from this step.** Concretely:",
    '',
    "- Paths the user has **deleted on disk but not yet committed** still exist in HEAD. A task targeting their replacement (the new, untracked path) will fail in the worktree because the new path doesn't exist there and the old one still does.",
    "- **Untracked / renamed files** are not in HEAD; tasks that name them by their new path will look like hallucinations to the executing agent.",
    "- A WIP refactor on disk (deletes + untracked together — usually a directory rename) is the most dangerous case: planning against the post-refactor structure produces tasks the executors universally reject.",
    '',
    'Before creating tasks, verify every path you reference exists in HEAD — `git ls-files <path>` and `git show HEAD:<path>` are the source of truth, **not** the on-disk listing. If a subtree appears mid-refactor in the list below, either skip planning over it or write tasks against its HEAD-committed shape.',
    '',
    `Diverged paths (${sample.length} of ${labelled.length}${omitted > 0 ? `, ${omitted} omitted` : ''}):`,
    '',
    '```',
    ...sample,
    ...(omitted > 0 ? [`... and ${omitted} more`] : []),
    '```',
    '',
  ].join('\n');
}
