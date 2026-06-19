// The catalog of editable instruction templates: the default markdown for each
// agent-facing brief Lattice writes, plus per-template token metadata for the
// settings editor. This module is a LEAF (it imports nothing from the render
// modules or the resolver) so both the renderers and the resolver can import
// the defaults from here without an import cycle.
//
// Each template is plain markdown with `{{token}}` placeholders for its dynamic
// parts. The renderers (taskPrompt.ts, mergePrompt.ts, …) import the matching
// DEFAULT_* constant, compute the token values, and run applyTemplate. The
// editor (editorData.ts) surfaces these defaults + the token docs and lets a
// user override the template per project.

export type InstructionTemplateId =
  | 'task'
  | 'merge'
  | 'qa'
  | 'push'
  | 'post-merge-hook'
  | 'workflow-step';

export type InstructionTemplateToken = {
  name: string;
  description: string;
};

export type InstructionTemplateDef = {
  id: InstructionTemplateId;
  title: string;
  filename: string;
  description: string;
  defaultTemplate: string;
  tokens: InstructionTemplateToken[];
};

// ---------------------------------------------------------------------------
// LATTICE_TASK.md
// ---------------------------------------------------------------------------
export const DEFAULT_TASK_TEMPLATE = `# {{task_title}}

{{task_description}}

---

**Lattice task ID:** \`{{task_id}}\`
**Project:** \`{{project_path}}\`
**Created:** {{created_at}}

> You are working on this single task. You should not need to query the
> Lattice task board to complete it — but if you do, pass exactly the
> project path above as \`project=\`, and see \`$LATTICE_DOCS\`
> (\`.lattice/LATTICE_API.md\`) for the API.

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

4. **Append a short summary of your changes to the task** so the task
   board reflects what was actually done once it lands in "Ready to
   Merge":

   \`\`\`
   curl -s -X POST {{backend_origin}}/api/tasks/{{task_id}}/append-summary \\
     -H "Content-Type: application/json" \\
     -d '{"summary":"<1-3 bullet summary of what changed>"}'
   \`\`\`

   Keep it concise (1-3 bullet points). This appends the summary beneath
   the original description — both remain visible on the task board.

{{final_step}}

Please do not start, stop, or restart any dev servers — the user runs
them in their own console and your output goes to the worktree's terminal.
`;

// ---------------------------------------------------------------------------
// MERGE_INSTRUCTIONS.md
// ---------------------------------------------------------------------------
export const DEFAULT_MERGE_TEMPLATE = `# Resolve merge conflict for task {{task_id}}

**Branch:** \`{{branch}}\`
**Task:** {{task_title}}

{{env_notes_block}}Lattice merged main into this branch and conflicts arose. Your job is to
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

// ---------------------------------------------------------------------------
// QA_INSTRUCTIONS.md
// ---------------------------------------------------------------------------
export const DEFAULT_QA_TEMPLATE = `# QA end-to-end test

You are running a **full end-to-end test** of a feature that has already been
merged into this project. Use the **Playwright MCP** browser tools to drive the
running app through the feature like a real user would, then report a verdict.

Project: \`{{project_path}}\`

## The feature under test

**{{task_title}}**

{{task_description}}

## Steps

1. \`cd "{{project_path}}"\` so you are working against the real project tree.
2. Understand what the feature does and where it lives. Skim the relevant
   source / recent git history (\`git log --oneline -15\`) if the description
   above is thin.
3. The project's app should already be running locally — **do not start, stop,
   or restart any dev servers** (the user runs them in their own console).
   Work out its local URL (check the README / \`package.json\` scripts / the
   ports it listens on) and open it with the Playwright browser tools.
4. Exercise the feature **end-to-end** with Playwright: navigate, click, type,
   and assert on what the page actually shows. Cover the main happy path and at
   least one edge/error case where it makes sense. The browser may be headless
   or headed depending on the QA-lane toggle — that's already configured.
5. Decide a verdict: **PASS** (the feature works as described) or **FAIL**
   (it doesn't — capture exactly what broke and how to reproduce it).
6. **As your final step, append your verdict to the Lattice task** so it stays
   on the task board after this terminal closes:

   \`\`\`bash
   curl -s -X POST {{summary_url}} \\
     -H "Content-Type: text/markdown" \\
     --data-binary @- <<'EOF'
   **QA e2e (Playwright):** PASS — <one-line verdict>
   - <what you tested>
   - <anything notable, or "no issues">
   EOF
   \`\`\`

   Replace the body with your real findings. On FAIL, lead with \`FAIL\` and the
   reproduction steps.

7. Then stop — Lattice's Stop hook closes this terminal automatically once you
   stop, so make sure the summary curl has already run.
`;

// ---------------------------------------------------------------------------
// PUSH_INSTRUCTIONS.md
// ---------------------------------------------------------------------------
export const DEFAULT_PUSH_TEMPLATE = `# Push to remote

Project: \`{{project_path}}\`

## Steps

1. \`cd "{{project_path}}"\`
2. Run \`git status\`. If there are uncommitted changes, stage and commit them
   with a concise message that describes the diff:
   \`\`\`
   git add -A
   git commit -m "<concise summary of the changes>"
   \`\`\`
   If the working tree is already clean, skip the commit step.
3. Push to the remote: \`git push\`. If push fails because the upstream isn't
   set, run \`git push -u origin HEAD\` instead.
4. Report a one-line summary of what you committed (if anything) and the push
   result. Then stop — the Lattice harness closes this terminal automatically
   once you stop.
`;

// ---------------------------------------------------------------------------
// POST_MERGE_HOOK.md
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// WORKFLOW_STEP.md  (array-joined — the body is dense with backticks/fences)
// ---------------------------------------------------------------------------
export const DEFAULT_WORKFLOW_STEP_TEMPLATE = [
  '# Workflow Step {{step_number}} of {{total_steps}}: {{step_title}}',
  '',
  '{{dirty_state_warning}}',
  '## Your Task',
  '',
  '{{autonomy_preamble}}{{step_prompt}}',
  '',
  '## Active project (use ONLY this one)',
  '',
  '`{{project_path}}`',
  '',
  'Every Lattice API call you make must be for this project. The helper',
  'script below has the project baked in — prefer it over raw curl so you',
  "can't accidentally hit a different project's board. If you do use curl,",
  "verify the response's `canonicalProject` field matches the path above",
  'before acting on the data.',
  '',
  '## Reading the board — query the API, not local files',
  '',
  'The live task DB is the API. **Do not read `tasks.json`, `tasks-current.json`,',
  '`combined-tasks.json`, `lattice_tasks.json`, or any similar file you find',
  'in this directory or sibling workflow-step directories** — those are stale',
  'scratch dumps left by previous agents and they will mislead you (the canonical',
  "example: they often miss whole lanes like 'qa' or 'ready_to_merge'). Always",
  "use `node create-task.cjs --list` or the API; that's the source of truth.",
  '',
  '{{harness_override_note}}You can inspect the project files at that path if helpful.',
  'Your primary role here is to create tasks on the Lattice board so that',
  'code agents can do the implementation work. Do not write or commit code directly.',
  '',
  '## Creating tasks — use the helper script',
  '',
  'A `create-task.cjs` script is in this directory. It handles JSON serialization',
  "for you so you never need to escape quotes, backticks, or special characters,",
  "and every command targets only this project's board.",
  '',
  '**Single task (inline description):**',
  '```bash',
  'node create-task.cjs "Task title" "Short description here"',
  '```',
  '',
  '**Single task with a long/complex description (write to a file first):**',
  '```bash',
  "cat > desc.md << 'EOF'",
  'Your description here. Backticks `like this`, quotes "like this",',
  'and even (parentheses) are all fine inside a single-quoted heredoc.',
  'EOF',
  'node create-task.cjs "Task title" < desc.md',
  '```',
  '',
  '**Multiple tasks at once (recommended when creating 3+ tasks):**',
  '```bash',
  "cat > tasks.json << 'EOF'",
  '[',
  '  { "title": "First task",  "description": "What to do" },',
  '  { "title": "Second task", "description": "Details..." }',
  ']',
  'EOF',
  'node create-task.cjs --batch tasks.json',
  '```',
  '',
  '### Read the board (always project-safe)',
  '```bash',
  'node create-task.cjs --list                  # every task on this project',
  'node create-task.cjs --list open             # one lane',
  'node create-task.cjs --list open,in_progress # multiple lanes',
  'node create-task.cjs --summary               # counts by status',
  '```',
  '',
  'If you ever need a raw curl, the response is an envelope — assert',
  '`.canonicalProject` matches the project path above before iterating',
  '`.tasks`:',
  '',
  '```bash',
  'curl -s "{{backend_origin}}/api/tasks?project={{project_path_encoded}}"',
  '# → { project, canonicalProject, hash, count, mismatched, tasks: [...] }',
  '```',
  '',
  '## When you are done',
  '',
  '{{completion_instructions}}',
].join('\n');

// ---------------------------------------------------------------------------
// Catalog (template + token docs) consumed by the settings editor.
// ---------------------------------------------------------------------------
const COMMON = {
  project_path: { name: 'project_path', description: 'Absolute path to the project repo.' },
  backend_origin: { name: 'backend_origin', description: 'Lattice backend base URL used in callback curls.' },
  task_id: { name: 'task_id', description: 'Lattice task id (used in callback URLs).' },
  task_title: { name: 'task_title', description: "The task's title." },
  task_description: {
    name: 'task_description',
    description: "The task's description (or a placeholder when empty).",
  },
  env_notes_block: {
    name: 'env_notes_block',
    description:
      "“Fresh worktree, don't reinstall” note for detected package managers (edit it under Worktree environment notes below). Empty when none are detected.",
  },
  autonomy_preamble: {
    name: 'autonomy_preamble',
    description:
      'Autonomy framing — empty for Claude; a “finish everything in this session” block for Pi/Codex.',
  },
} as const;

export const INSTRUCTION_TEMPLATE_CATALOG: InstructionTemplateDef[] = [
  {
    id: 'task',
    title: 'Task brief',
    filename: 'LATTICE_TASK.md',
    description:
      "Written into a task's worktree when you run an Open task — the agent reads it as its instructions.",
    defaultTemplate: DEFAULT_TASK_TEMPLATE,
    tokens: [
      COMMON.task_title,
      COMMON.task_description,
      COMMON.task_id,
      COMMON.project_path,
      { name: 'created_at', description: 'Task creation time (ISO).' },
      COMMON.backend_origin,
      COMMON.autonomy_preamble,
      COMMON.env_notes_block,
      {
        name: 'dead_code_block',
        description:
          'Optional dead-code note — present only when the analyzer flags unreachable files.',
      },
      {
        name: 'final_step',
        description:
          'The closing step — Claude stops silently (Stop hook); Pi/Codex curl /complete.',
      },
    ],
  },
  {
    id: 'merge',
    title: 'Merge-conflict resolver',
    filename: 'MERGE_INSTRUCTIONS.md',
    description:
      'Written into a worktree when merging main into a branch hits conflicts. A resolver Claude reads it, resolves the markers, and commits.',
    defaultTemplate: DEFAULT_MERGE_TEMPLATE,
    tokens: [
      COMMON.task_id,
      { name: 'branch', description: 'The branch being merged.' },
      COMMON.task_title,
      COMMON.task_description,
      COMMON.env_notes_block,
      {
        name: 'conflicted_files',
        description: 'Bullet list of files in conflict (or a hint to run git diff).',
      },
      COMMON.backend_origin,
    ],
  },
  {
    id: 'qa',
    title: 'QA end-to-end test',
    filename: 'QA_INSTRUCTIONS.md',
    description:
      'The brief for a QA-lane “run e2e test” session (when the QA-lane Playwright toggle is on). A Playwright-enabled Claude drives the merged feature and posts a PASS/FAIL verdict.',
    defaultTemplate: DEFAULT_QA_TEMPLATE,
    tokens: [
      COMMON.project_path,
      COMMON.task_title,
      COMMON.task_description,
      {
        name: 'summary_url',
        description: 'The /append-summary callback URL for posting the verdict.',
      },
    ],
  },
  {
    id: 'push',
    title: 'Push to remote',
    filename: 'PUSH_INSTRUCTIONS.md',
    description:
      'The brief for the QA-lane Push button. A one-off Claude session commits any pending changes and pushes to the remote.',
    defaultTemplate: DEFAULT_PUSH_TEMPLATE,
    tokens: [COMMON.project_path],
  },
  {
    id: 'post-merge-hook',
    title: 'Post-merge hook',
    filename: 'POST_MERGE_HOOK.md',
    description:
      "The frame around your post-merge hook prompt. Runs after each successful merge; the merge isn't complete until this agent calls back.",
    defaultTemplate: DEFAULT_POST_MERGE_HOOK_TEMPLATE,
    tokens: [
      COMMON.project_path,
      { name: 'hook_prompt', description: 'Your configured post-merge hook prompt.' },
      { name: 'callback_url', description: 'The hook-complete callback URL.' },
      {
        name: 'stop_hook_note',
        description: 'Harness-specific backstop note (Claude / Pi / Codex).',
      },
    ],
  },
  {
    id: 'workflow-step',
    title: 'Workflow step',
    filename: 'WORKFLOW_STEP.md',
    description:
      'The brief for an agent step in a workflow run. The planner reads it and creates tasks on the board via the bundled helper script.',
    defaultTemplate: DEFAULT_WORKFLOW_STEP_TEMPLATE,
    tokens: [
      { name: 'step_number', description: 'This step’s position (1-based).' },
      { name: 'total_steps', description: 'Total number of steps in the workflow.' },
      { name: 'step_title', description: 'This step’s title.' },
      {
        name: 'dirty_state_warning',
        description:
          'Warning block when the project tree has uncommitted changes; empty otherwise.',
      },
      COMMON.autonomy_preamble,
      {
        name: 'step_prompt',
        description: 'Your step prompt, with {{variables}} already substituted.',
      },
      COMMON.project_path,
      {
        name: 'project_path_encoded',
        description: 'URL-encoded project path for the raw-curl example.',
      },
      COMMON.backend_origin,
      {
        name: 'harness_override_note',
        description: 'Note shown when the run forces one harness; empty otherwise.',
      },
      {
        name: 'completion_instructions',
        description:
          'How to finish the step — Claude stops; Pi/Codex curl /complete.',
      },
    ],
  },
];

export function getInstructionTemplateDef(
  id: string,
): InstructionTemplateDef | undefined {
  return INSTRUCTION_TEMPLATE_CATALOG.find((t) => t.id === id);
}
