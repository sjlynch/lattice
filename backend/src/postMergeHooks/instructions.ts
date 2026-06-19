import type { AgentHarness } from '../harnesses.js';
import { applyTemplate } from '../instructionTemplates/apply.js';
import { DEFAULT_POST_MERGE_HOOK_TEMPLATE } from '../instructionTemplates/defs.js';

// Markdown brief written to <hookScratch>/POST_MERGE_HOOK.md. The harness is
// launched with cwd=scratchDir (so its Stop hook / shutdown extension picks
// up the per-run settings) — the brief is responsible for sending the agent
// into the actual project as step 1. This mirrors the push-run pattern.
//
// Two completion paths are documented intentionally:
//   1. The Claude Stop hook in this scratch dir's
//      .claude/settings.local.json (or the Pi extension under
//      .pi/extensions/) will curl the callback automatically — the backstop.
//   2. The harness is also instructed to curl the callback as its final step,
//      so Codex/any harness without a Stop hook still releases the merge.
//
// Updated context for harnesses: this file is the post-merge-hook analogue of
// LATTICE_TASK.md. Whichever harness reads it must explicitly call back when
// done — Lattice will not advance the merge run / unblock the workflow merge
// step until /api/post-merge-hooks/<id>/complete fires.

export function renderPostMergeHookInstructions(args: {
  projectPath: string;
  prompt: string;
  callbackUrl: string;
  harness: AgentHarness;
  template?: string;
}): string {
  const { projectPath, prompt, callbackUrl, harness } = args;
  const stopHookNote =
    harness === 'claude'
      ? 'Your Stop hook in this directory will call this URL automatically when this Claude session stops — but you should still curl it explicitly as your last action so completion is not delayed by hook-init quirks.'
      : harness === 'pi'
      ? 'A Pi completion extension in this directory will fetch this URL automatically on session shutdown — but you should still curl it explicitly as your last action.'
      : 'Codex has no Stop-hook equivalent, so you MUST curl this URL yourself before exiting — otherwise Lattice will block the merge run waiting for you indefinitely.';

  return applyTemplate(args.template ?? DEFAULT_POST_MERGE_HOOK_TEMPLATE, {
    project_path: projectPath,
    hook_prompt: prompt.trim(),
    callback_url: callbackUrl,
    stop_hook_note: stopHookNote,
  });
}
