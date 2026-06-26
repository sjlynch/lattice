// Post-merge hook lifecycle. The hook itself is configured per-project via
// `userSettings.postMergeHookPrompt` / `.postMergeHookHarness`; these helpers
// expose the active/recent run + Stop-hook completion callbacks so the
// taskboard row can render the running terminal banner and an Abort button.

import { postJson } from './http';
import { subscribeWs } from './ws';
import type {
  PostMergeHookEvent,
  PostMergeHookRun,
  PostMergeHookSnapshot,
} from './types/postMergeHooks';

export async function getActivePostMergeHook(
  projectPath: string,
): Promise<PostMergeHookSnapshot> {
  const r = await fetch(
    `/api/post-merge-hooks/active?project=${encodeURIComponent(projectPath)}`,
  );
  if (!r.ok) return { active: null, recent: null };
  return r.json();
}

export async function abortPostMergeHook(id: string): Promise<void> {
  await postJson<{ ok: true }>(
    `/api/post-merge-hooks/${encodeURIComponent(id)}/abort`,
  );
}

export function subscribePostMergeHooks(
  projectPath: string,
  onEvent: (ev: PostMergeHookEvent) => void,
): () => void {
  return subscribeWs<PostMergeHookEvent>(
    `/ws/post-merge-hooks?project=${encodeURIComponent(projectPath)}`,
    onEvent,
  );
}

export type { PostMergeHookEvent, PostMergeHookRun, PostMergeHookSnapshot };
