// The catalog of editable instruction templates: the default markdown for each
// agent-facing brief Lattice writes, plus per-template token metadata for the
// settings editor. This module is a LEAF (it imports nothing from the render
// modules or the resolver) so both the renderers and the resolver can import
// the defaults from here without an import cycle.
//
// Each template is plain markdown with `{{token}}` placeholders for its dynamic
// parts. The long DEFAULT_* markdown bodies live in focused per-template leaf
// modules under `templates/` and are re-exported here (so existing
// `defs.js` import paths keep working); this file stays the type definitions
// plus the registry (catalog) assembly. The renderers (taskPrompt.ts,
// mergePrompt.ts, …) import the matching DEFAULT_* constant, compute the token
// values, and run applyTemplate. The editor (editorData.ts) surfaces these
// defaults + the token docs and lets a user override the template per project.

import { DEFAULT_TASK_TEMPLATE } from './templates/task.js';
import { DEFAULT_MERGE_TEMPLATE } from './templates/merge.js';
import { DEFAULT_QA_TEMPLATE } from './templates/qa.js';
import { DEFAULT_PUSH_TEMPLATE } from './templates/push.js';
import { DEFAULT_POST_MERGE_HOOK_TEMPLATE } from './templates/postMergeHook.js';
import { DEFAULT_WORKFLOW_STEP_TEMPLATE } from './templates/workflowStep.js';
import { DEFAULT_RUN_TESTS_TEMPLATE } from './templates/runTests.js';
import { DEFAULT_WORKFLOW_PUSH_TEMPLATE } from './templates/workflowPush.js';

export {
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_MERGE_TEMPLATE,
  DEFAULT_QA_TEMPLATE,
  DEFAULT_PUSH_TEMPLATE,
  DEFAULT_POST_MERGE_HOOK_TEMPLATE,
  DEFAULT_WORKFLOW_STEP_TEMPLATE,
  DEFAULT_RUN_TESTS_TEMPLATE,
  DEFAULT_WORKFLOW_PUSH_TEMPLATE,
};

export type InstructionTemplateId =
  | 'task'
  | 'merge'
  | 'qa'
  | 'push'
  | 'post-merge-hook'
  | 'workflow-step'
  | 'run-tests'
  | 'workflow-push';

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
  verification: {
    name: 'verification',
    description:
      'The “don’t run tests, builds or type-checks” rule (or “type-check only”, per the checkbox on this tab). Appended if an override omits it; the same rule also rides the agent’s system prompt.',
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
      COMMON.verification,
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
      COMMON.verification,
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
      {
        name: 'verdict_url',
        description:
          'The /verdict callback URL for the structured PASS/FAIL + confidence report; a confident PASS auto-advances the task qa → done.',
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
    id: 'workflow-push',
    title: 'Workflow Push step',
    filename: 'PUSH_INSTRUCTIONS.md',
    description:
      "The brief for a workflow's Push step. A one-off Claude session pushes the commits already on the branch — it never stages or commits, and reports any uncommitted files it left alone. (The QA-lane Push button uses the “Push to remote” brief above.)",
    defaultTemplate: DEFAULT_WORKFLOW_PUSH_TEMPLATE,
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
      {
        name: 'tool_reports',
        description:
          'Reports from the step’s pre-run tools (e.g. the Opengrep scan → OPENGREP_FINDINGS.md beside this brief: counts, what the file holds, the fingerprint-marker rule). Empty when the step has no tools.',
      },
      COMMON.project_path,
      {
        name: 'project_path_encoded',
        description: 'URL-encoded project path for the raw-curl example.',
      },
      {
        name: 'lattice_api_doc_path',
        description:
          'Absolute path to the auto-managed full API cheatsheet (<project>/.lattice/LATTICE_API.md).',
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
  {
    id: 'run-tests',
    title: 'Workflow Run tests step',
    filename: 'RUN_TESTS.md',
    description:
      "The brief for a workflow's Run tests step. The agent runs the project's tests on the main checkout, fixes what it can, commits the fixes (only the files it changed), leaves the user's uncommitted work alone, and writes TEST_SUMMARY.md, which Lattice shows on the run.",
    defaultTemplate: DEFAULT_RUN_TESTS_TEMPLATE,
    tokens: [
      { name: 'step_number', description: 'This step’s position (1-based).' },
      { name: 'total_steps', description: 'Total number of steps in the workflow.' },
      COMMON.autonomy_preamble,
      COMMON.project_path,
      {
        name: 'step_dir',
        description:
          'The step’s scratch directory (the session cwd, holding the completion hooks, USER_WIP.txt and TEST_SUMMARY.md).',
      },
      {
        name: 'timeout_minutes',
        description:
          'The step’s timeout — Lattice stops the session after this many minutes and moves on.',
      },
      {
        name: 'recent_tasks',
        description:
          'Tasks moved to QA/Done since the last Run tests (else since this run started): title plus the first lines of each description, up to 30.',
      },
      {
        name: 'user_wip_file',
        description:
          'Absolute path of USER_WIP.txt — every file modified, staged or untracked in the checkout when the step started.',
      },
      {
        name: 'user_wip_summary',
        description: 'A short count of that list (or “none — the checkout was clean”).',
      },
      {
        name: 'test_summary_file',
        description: 'Absolute path of the TEST_SUMMARY.md report the agent writes.',
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
