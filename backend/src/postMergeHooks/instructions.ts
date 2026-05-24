import type { AgentHarness } from '../harnesses.js';

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
}): string {
  const { projectPath, prompt, callbackUrl, harness } = args;
  const stopHookNote =
    harness === 'claude'
      ? 'Your Stop hook in this directory will call this URL automatically when this Claude session stops — but you should still curl it explicitly as your last action so completion is not delayed by hook-init quirks.'
      : harness === 'pi'
      ? 'A Pi completion extension in this directory will fetch this URL automatically on session shutdown — but you should still curl it explicitly as your last action.'
      : 'Codex has no Stop-hook equivalent, so you MUST curl this URL yourself before exiting — otherwise Lattice will block the merge run waiting for you indefinitely.';

  return `# Post-merge hook

Lattice just finished merging one or more tasks into \`main\` for this project:

\`${projectPath}\`

The merge is **not yet considered complete** — the user configured a
post-merge hook with the task below, and any workflow waiting on the merge
step (or per-task merge response) is blocked until you call back to Lattice.

## Step 1 — switch into the project

This session starts in a Lattice-managed scratch directory so the Stop hook
that reports completion is loaded correctly. Before doing anything else, cd
into the project repo:

\`\`\`
cd "${projectPath}"
\`\`\`

Run all subsequent commands (\`git status\`, tests, edits, etc.) from inside
the project. **Do not** modify anything in this scratch directory — it is
recreated for every hook run and any state here is lost.

## Step 2 — your task

${prompt.trim()}

## Step 3 — report completion

When you're done (success **or** failure), curl this URL exactly once before
exiting:

\`\`\`
curl -s -m 5 -X POST "${callbackUrl}?source=model-explicit-curl"
\`\`\`

${stopHookNote}

If something went wrong and you cannot finish, still call the URL — pass
\`?error=<short message>\` (URL-encoded) so the UI surfaces the failure
instead of leaving the merge run blocked. Example:

\`\`\`
curl -s -m 5 -X POST "${callbackUrl}?source=model-explicit-curl&error=tests%20failed"
\`\`\`
`;
}
