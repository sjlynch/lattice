import path from 'node:path';
import type { Task } from '../tasks.js';
import { homeWorktreesDir } from '../projectPath.js';
import { MAX_PATH_RETRY_SUFFIXES } from './reconcile.js';

export type WorktreeSetupCandidate = {
  attempt: number;
  suffix: string;
  candidatePath: string;
  candidateBranch: string;
};

export type WorktreeCandidatePlan = {
  slug: string;
  shortId: string;
  worktreesDir: string;
  candidates: WorktreeSetupCandidate[];
};

export function slugifyTaskTitle(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

export function buildWorktreeCandidatePlan(
  repoRoot: string,
  task: Pick<Task, 'id' | 'title'>,
): WorktreeCandidatePlan {
  const slug = slugifyTaskTitle(task.title);
  const shortId = task.id.slice(-6);
  const worktreesDir = homeWorktreesDir(repoRoot);
  const candidates: WorktreeSetupCandidate[] = [];

  for (let attempt = 0; attempt <= MAX_PATH_RETRY_SUFFIXES; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-r${attempt + 1}`;
    candidates.push({
      attempt,
      suffix,
      candidatePath: path.join(worktreesDir, `${slug}-${shortId}${suffix}`),
      candidateBranch: `lattice/${slug}-${shortId}${suffix}`,
    });
  }

  return { slug, shortId, worktreesDir, candidates };
}

export function canonicalWorktreePath(plan: WorktreeCandidatePlan): string {
  return path.join(plan.worktreesDir, `${plan.slug}-${plan.shortId}`);
}
