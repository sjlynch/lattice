import { installClaudeHooks } from '../claudeStopHook.js';
import type { AgentHarness } from '../harnesses.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { installCodexStopHook } from '../codexStopHook.js';
import { installPiActivityExtension } from '../piActivity.js';
import { installPiSubagentsShim } from '../piSubagents.js';
import { buildAgentActivityUrl } from '../agentActivityTokens.js';

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
// dir. The hook's work targets the project root, but we cannot write
// `.claude/settings.local.json` next to the project's checkout (would
// clobber the user's own Claude config). So the pty is spawned with
// cwd = this home-scoped scratch dir (see trigger.ts): Claude reads the
// scratch `.claude/settings.local.json`, Pi the scratch `.pi/extensions/`,
// Codex the scratch `.codex/hooks.json`, and POST_MERGE_HOOK.md tells the
// agent to `cd` into the project as its first step.
//
// Defence-in-depth (the "always install both" rule, see piExtension.ts):
// we always install the Claude Stop hook, the Pi extension, AND the Codex
// Stop hook regardless of harness, so a mid-run harness switch (e.g. the user
// respawns under a different harness) doesn't lose the backstop. The unused
// hooks are inert — only the harness that actually runs reads its own. (Codex
// gained a Stop-hook backstop too — see codexStopHook.ts — so POST_MERGE_HOOK.md
// no longer relies solely on the model's explicit curl.)
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
  const activityUrl = buildAgentActivityUrl(backendOrigin, {
    agentId: postMergeHookAgentId(id),
    projectPath,
    label: 'post-merge hook',
  });
  await installClaudeHooks(scratchDir, {
    completeUrl: `${callbackUrl}?source=claude-stop-hook-post-merge-hook-complete`,
    activityUrl,
  });
  await installPiCompletionExtension({
    dir: scratchDir,
    callbackUrl,
    site: 'post-merge-hook-complete',
    respectQuitGate: false,
  });
  await installPiActivityExtension({ dir: scratchDir, activityUrl });
  // Codex Stop hook (the Codex analogue). Home-scoped scratch is fresh, so
  // 'always'. Advances the merge gate on turn completion even if the model
  // forgets the explicit curl.
  await installCodexStopHook(
    scratchDir,
    `${callbackUrl}?source=codex-stop-hook-post-merge-hook-complete`,
    'always',
    activityUrl,
  );
  // pi-subagents loader shim alongside the completion extension (no-op until
  // the shared install resolves). Scratch is home-scoped (outside the repo).
  await installPiSubagentsShim({ dir: scratchDir });
  console.log(
    `[post-merge-hook] installed Claude+Pi+Codex backstops for ${id} ` +
      `(active harness=${harness}, scratch=${scratchDir})`,
  );
}
