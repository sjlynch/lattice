// Push-run helpers: kick off a Claude session that commits + pushes the
// active project, and poll for completion so the UI can auto-close the
// terminal once Claude's Stop hook has fired on the backend.

import { asJson, postJson } from './http';
import type { PushRunStatus, StartPushRunResult } from './types';
export type { PushRunStatus, StartPushRunResult } from './types';

export async function checkGit(projectPath: string): Promise<{ hasGit: boolean }> {
  return asJson<{ hasGit: boolean }>(
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
