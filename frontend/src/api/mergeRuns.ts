// Merge-run lifecycle (start, status, cancel) + live event subscription.

import { postJson } from './http';
import { subscribeWs } from './ws';
import type { MergeRun, MergeRunEvent } from './types';

export async function startMergeRun(projectPath: string): Promise<MergeRun> {
  return postJson<MergeRun>('/api/merge-runs', { project: projectPath });
}

export async function getActiveMergeRun(
  projectPath: string,
): Promise<MergeRun | null> {
  const r = await fetch(
    `/api/merge-runs/active?project=${encodeURIComponent(projectPath)}`,
  );
  if (!r.ok) return null;
  return r.json();
}

export async function cancelMergeRun(runId: string): Promise<void> {
  await postJson<{ ok: true }>(
    `/api/merge-runs/${encodeURIComponent(runId)}/cancel`,
  );
}

export function subscribeMergeRuns(
  projectPath: string,
  onEvent: (ev: MergeRunEvent) => void,
): () => void {
  return subscribeWs<MergeRunEvent>(
    `/ws/merge-runs?project=${encodeURIComponent(projectPath)}`,
    onEvent,
  );
}
