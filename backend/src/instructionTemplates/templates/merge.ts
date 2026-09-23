// MERGE_INSTRUCTIONS.md — written into a worktree when merging main into a
// branch hits conflicts; a resolver Claude reads it. Leaf module: a
// plain-markdown default with `{{token}}` placeholders. See ../defs.ts for the
// catalog entry (token docs) and ../CLAUDE.md for the subsystem overview.

export const DEFAULT_MERGE_TEMPLATE = `# Resolve merge conflict for task {{task_id}}

**Branch:** \`{{branch}}\`
**Task:** {{task_title}}

{{verification}}{{env_notes_block}}Lattice merged main into this branch and conflicts arose. Your job is to
resolve them and commit. After you commit and the session ends, Lattice's
existing Stop hook fires and the backend will fast-forward main and clean
up automatically.

## Intent

{{task_description}}

## Files in conflict

{{conflicted_files}}

## Steps (please complete autonomously, no need to confirm with the user)

1. Inspect each conflicted file. Resolve all \`<<<<<<<\` / \`=======\` /
   \`>>>>>>>\` markers, preserving the intent of both branches when possible.
2. Stage the resolved files: \`git add <file> ...\`
3. Complete the merge with a commit message that names the task and briefly
   describes how you resolved the conflict — do not just accept git's default:
   \`\`\`
   git commit -m "Merge main → {{task_title}}: <one-line summary of resolution>"
   \`\`\`
   Example summaries: "kept incoming auth refactor over local stub",
   "merged both sides of config split", "accepted ours on pipeline.rs".

   **If the commit fails with an identity error** ("Author identity unknown" /
   "Please tell me who you are"), resolve it and continue — do not abort the
   merge over it, and **never fix it with \`git config\`**: \`--global\`
   rewrites the user's machine, and \`--local\` rewrites the project repo this
   worktree shares. Read the identity the repo already uses and pass it to the
   one command, which persists nothing:

   \`\`\`
   git log -1 --format="%an <%ae>"
   git -c user.name="<name>" -c user.email="<email>" commit -m "<message>"
   \`\`\`
4. End the session normally. The Stop hook in
   \`.claude/settings.local.json\` will notify Lattice automatically.

If for any reason the Stop hook doesn't fire, you can call the API
directly as a fallback:

\`\`\`
curl -s -X POST {{backend_origin}}/api/tasks/{{task_id}}/merged
\`\`\`

## If you cannot resolve

If the conflicts cannot be reasonably resolved, abort and report:

\`\`\`
git merge --abort
curl -s -X POST {{backend_origin}}/api/tasks/{{task_id}}/merge-aborted \\
  -H "Content-Type: application/json" \\
  -d '{"reason":"<short reason>"}'
\`\`\`

The user can then retry the merge from the Lattice task board.
`;
