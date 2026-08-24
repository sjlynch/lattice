// Push-run helpers: kick off a Claude session that commits + pushes the
// active project, and poll for completion so the UI can auto-close the
// terminal once Claude's Stop hook has fired on the backend.

import { asJson, postJson } from './http';
import type { ProjectGitProbe, PushRunStatus, StartPushRunResult } from './types';
export type { PushRunStatus, StartPushRunResult } from './types';

// `hasGit` keeps its exact original semantics — a plain stat of
// `<path>/.git`, which the QA-lane Push button reads. `git` is the additive
// Git-setup probe: it walks UP, so it also reports the `nested` case that
// `hasGit` deliberately can't see. Consumers of `git` must tolerate it being
// absent at runtime (an older backend still answers this route).
export async function checkGit(
  projectPath: string,
): Promise<{ hasGit: boolean; git: ProjectGitProbe }> {
  return asJson<{ hasGit: boolean; git: ProjectGitProbe }>(
    await fetch(`/api/git-check?path=${encodeURIComponent(projectPath)}`),
  );
}

export async function startPushRun(projectPath: string): Promise<StartPushRunResult> {
  return postJson<StartPushRunResult>('/api/push-runs', {
    project: projectPath,
  });
}

export async function fetchPushRunStatus(id: string): Promise<{ status: PushRunStatus } | null> {
  const r = await fetch(`/api/push-runs/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  return asJson<{ status: PushRunStatus }>(r);
}

export async function forgetPushRun(id: string): Promise<void> {
  await fetch(`/api/push-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}
