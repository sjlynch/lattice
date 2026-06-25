// POST_MERGE_HOOK.md — the frame around a project's post-merge hook prompt.
// Leaf module: a plain-markdown default with `{{token}}` placeholders. See
// ../defs.ts for the catalog entry (token docs) and ../CLAUDE.md for the
// subsystem overview.

export const DEFAULT_POST_MERGE_HOOK_TEMPLATE = `# Post-merge hook

Lattice just finished merging one or more tasks into \`main\` for this project:

\`{{project_path}}\`

The merge is **not yet considered complete** — the user configured a
post-merge hook with the task below, and any workflow waiting on the merge
step (or per-task merge response) is blocked until you call back to Lattice.

## Step 1 — switch into the project

This session starts in a Lattice-managed scratch directory so the Stop hook
that reports completion is loaded correctly. Before doing anything else, cd
into the project repo:

\`\`\`
cd "{{project_path}}"
\`\`\`

Run all subsequent commands (\`git status\`, tests, edits, etc.) from inside
the project. **Do not** modify anything in this scratch directory — it is
recreated for every hook run and any state here is lost.

## Step 2 — your task

{{hook_prompt}}

## Step 3 — report completion

When you're done (success **or** failure), curl this URL exactly once before
exiting:

\`\`\`
curl -s -m 5 -X POST "{{callback_url}}?source=model-explicit-curl"
\`\`\`

{{stop_hook_note}}

If something went wrong and you cannot finish, still call the URL — pass
\`?error=<short message>\` (URL-encoded) so the UI surfaces the failure
instead of leaving the merge run blocked. Example:

\`\`\`
curl -s -m 5 -X POST "{{callback_url}}?source=model-explicit-curl&error=tests%20failed"
\`\`\`
`;
