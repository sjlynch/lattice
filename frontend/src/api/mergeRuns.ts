// Merge-run lifecycle (start, status, cancel) + live event subscription.

import { asJson } from './http';
import { subscribeWs } from './ws';
import type { MergeRun, MergeRunEvent } from './types';

export async function startMergeRun(projectPath: string): Promise<MergeRun> {
  return asJson<MergeRun>(
    await fetch('/api/merge-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    }),
  );
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
  await asJson<{ ok: true }>(
    await fetch(`/api/merge-runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
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
