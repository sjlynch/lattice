import { installClaudeHooks } from '../claudeStopHook.js';
import type { AgentHarness } from '../harnesses.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { installPiSubagentsShim } from '../piSubagents.js';
import { buildAgentActivityUrl } from '../agentActivity.js';

export function postMergeHookCallbackUrl(
  id: string,
  backendOrigin: string,
): string {
  return `${backendOrigin}/api/post-merge-hooks/${id}/complete`;
}

// Stable graph-node id for a post-merge-hook session.
export function postMergeHookAgentId(id: string): string {
  return `pmh:${id}`;
}

// Installs the harness-specific completion plumbing into the hook scratch
// dir. The hook *runs* with cwd=project root, so we cannot write
// `.claude/settings.local.json` next to the project's checkout (would
// clobber the user's own Claude config). Instead we both:
//   1. Write the Stop hook config into the scratch dir.
//   2. Reuse the same scratch dir as Claude's --add-dir / cwd hint in the
//      command (see command builder).
//
// The harness command itself does `cd <scratchDir>` before launching the
// agent, so Claude picks up the scratch `.claude/settings.local.json` while
// the model still operates against the project repo via explicit absolute
// paths in POST_MERGE_HOOK.md.
//
// Defence-in-depth (the "always install both" rule, see piExtension.ts):
// we always install the Claude Stop hook AND the Pi extension regardless
// of harness, so a mid-run harness switch (e.g. the user respawns under a
// different harness) doesn't lose the backstop. The unused hook is inert
// — only the harness that actually runs reads it. Codex still has no
// backstop and must explicitly curl per POST_MERGE_HOOK.md.
//
// Pi gate: this site has no PTY-kill side effect, so we disable the
// `reason === 'quit'` gate — abnormal exits should still produce a
// callback or the merge-run stays blocked forever.
export async function installPostMergeHookStopHook(args: {
  scratchDir: string;
  id: string;
  backendOrigin: string;
  projectPath: string;
  // `harness` is retained for logging/observability but is no longer used
  // to gate installation — see the defence-in-depth note above.
  harness: AgentHarness;
}): Promise<void> {
  const { scratchDir, id, backendOrigin, harness, projectPath } = args;
  const callbackUrl = postMergeHookCallbackUrl(id, backendOrigin);
  // Stop-hook URL carries `?source=` so the /complete log line can identify
  // the firing mechanism (Stop hook curl vs Pi extension fetch vs model
  // explicit curl). Pi extension does the same via piExtension.ts. The
  // activity hooks feed the graph's orange node + focus beams.
  await installClaudeHooks(scratchDir, {
    completeUrl: `${callbackUrl}?source=claude-stop-hook-post-merge-hook-complete`,
    activityUrl: buildAgentActivityUrl(backendOrigin, {
      agentId: postMergeHookAgentId(id),
      projectPath,
      label: 'post-merge hook',
    }),
  });
  await installPiCompletionExtension({
    dir: scratchDir,
    callbackUrl,
    site: 'post-merge-hook-complete',
    respectQuitGate: false,
  });
  // pi-subagents loader shim alongside the completion extension (no-op until
  // the shared install resolves). Scratch is home-scoped (outside the repo).
  await installPiSubagentsShim({ dir: scratchDir });
  console.log(
    `[post-merge-hook] installed Claude+Pi backstops for ${id} ` +
      `(active harness=${harness}, scratch=${scratchDir})`,
  );
}
