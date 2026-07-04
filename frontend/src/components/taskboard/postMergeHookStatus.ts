import type { PostMergeHookRun } from '../../api';

// Pure derivation of the post-merge hook row's collapsed-strip status chip,
// split out of `PostMergeHookRow.tsx` so it can be reasoned about (and unit-
// tested) in isolation without pulling in React / form-sync / harness state.

export type PostMergeHookStatusTone = 'running' | 'ok' | 'warn' | 'idle' | 'off';

export type PostMergeHookStatus = {
  text: string;
  tone: PostMergeHookStatusTone;
};

// A hook is "configured" when it has a non-empty prompt (whitespace-only
// counts as blank). The hook only fires when BOTH this and the master
// `enabled` toggle hold.
export function isPostMergeHookConfigured(prompt: string): boolean {
  return prompt.trim().length > 0;
}

// Status chip shown in the collapsed strip. The active state is the strong
// signal (it pulses); the recent state degrades to a quieter result label.
// `configured` = a non-empty prompt; `enabled` = the master toggle. The hook
// only fires when BOTH hold, so a configured-but-disabled hook reads as off.
export function postMergeHookStatusLabel(
  active: PostMergeHookRun | null,
  recent: PostMergeHookRun | null,
  configured: boolean,
  enabled: boolean,
): PostMergeHookStatus {
  if (active) return { text: 'Hook running', tone: 'running' };
  if (recent) {
    if (recent.status === 'completed') return { text: 'Last hook: ok', tone: 'ok' };
    if (recent.status === 'aborted') return { text: 'Last hook: aborted', tone: 'warn' };
    if (recent.status === 'errored') return { text: 'Last hook: error', tone: 'warn' };
  }
  if (!configured) return { text: 'Off', tone: 'off' };
  if (!enabled) return { text: 'Disabled', tone: 'off' };
  return { text: 'Configured', tone: 'idle' };
}
