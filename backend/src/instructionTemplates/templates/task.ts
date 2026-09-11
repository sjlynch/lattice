// LATTICE_TASK.md — written into a task's worktree when an Open task runs.
// Leaf module: a plain-markdown default with `{{token}}` placeholders. See
// ../defs.ts for the catalog entry (token docs) and ../CLAUDE.md for the
// subsystem overview.

export const DEFAULT_TASK_TEMPLATE = `# {{task_title}}

{{task_description}}

---

**Lattice task ID:** \`{{task_id}}\`
**Project:** \`{{project_path}}\`
**Created:** {{created_at}}

> You are working on this single task. You should not need to query the
> Lattice task board to complete it — but if you do, use the \`lattice\` MCP
> tools if this session has them; otherwise pass exactly the project path
> above as \`project=\`, and see
> \`{{project_path}}/.lattice/LATTICE_API.md\` for the API.

## Instructions (please complete autonomously, no need to confirm with the user)

{{autonomy_preamble}}{{env_notes_block}}{{dead_code_block}}1. **Check existing state first.** This task may have been started in a
   prior session — Lattice can resume worktrees after a server restart or
   when Claude finishes without committing. Before doing anything, run:

   \`\`\`
   git log --oneline -10
   git status
   \`\`\`

   - If there are commits on this branch, read them with \`git show <sha>\`
     to understand what's already been implemented.
   - If there are uncommitted changes, review them with \`git diff\` and
     decide whether to keep, amend, or rework them.
   - Only redo work that's clearly broken or out of scope. Don't restart
     the implementation from scratch when it's already partially done.

2. Implement the task described above (continuing from the prior state if
   any).

3. **Commit your work** before ending the session — Lattice merges your
   branch via \`git merge\`, so a commit is required for changes to land:

   \`\`\`
   git add -A
   git commit -m "<concise summary of the change>"
   \`\`\`

   **If the commit fails with an identity error** ("Author identity unknown" /
   "Please tell me who you are"), you can still finish — but
   **never fix it with \`git config\`**: \`--global\` rewrites the user's
   machine, and \`--local\` rewrites the project repo this worktree shares.
   Read the identity the repo already uses and pass it to the one command,
   which persists nothing:

   \`\`\`
   git log -1 --format="%an <%ae>"
   git -c user.name="<name>" -c user.email="<email>" commit -m "<message>"
   \`\`\`

   If the repo has no commits to read an identity from, commit as
   \`Lattice Agent <lattice@localhost>\` and say so in your summary.

4. **Append a short summary of your changes to the task** so the task
   board reflects what was actually done once it lands in "Ready to
   Merge":

   Prefer the \`lattice\` MCP tool \`append_summary\` with no \`id\`: this
   session already knows which task it is running (\`my_task\`), and the tool
   serializes your summary safely.

   Without that tool, use your file-writing tool to put the summary in a
   temporary UTF-8 markdown file outside the checkout, then send that file
   verbatim. Replace the file path below with its actual absolute path; on
   Windows use \`curl.exe\` to avoid PowerShell's \`curl\` alias:

   \`\`\`
   curl --fail-with-body --silent --show-error -X POST "{{backend_origin}}/api/tasks/{{task_id}}/append-summary" -H "Content-Type: text/markdown; charset=utf-8" --data-binary "@<absolute-path-to-summary.md>"
   \`\`\`

   Keep it concise (1-3 bullet points). The file contains only your summary,
   with ordinary quotes, backslashes, and newlines — no JSON wrapper or manual
   escaping. Check that the request succeeds before finishing. This appends
   beneath the original description; both remain visible on the task board.

{{final_step}}

Please do not start, stop, or restart any dev servers — the user runs
them in their own console and your output goes to the worktree's terminal.
`;
