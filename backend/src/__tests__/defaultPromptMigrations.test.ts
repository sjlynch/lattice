import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROMPT_MIGRATIONS,
  migrateDefaultPromptText,
  migrateWorkflowDefaultPrompts,
  migrateWorkflowStepPrompts,
} from '../workflows/defaultPromptMigrations.js';
import type { Workflow, WorkflowStep } from '../workflows.js';
import { renderStepMarkdown } from '../workflowRuns/stepMarkdown.js';
import type { WorkflowRun } from '../workflowRuns/state.js';

// A workflow step used to be able to read two contradictory instructions in one
// WORKFLOW_STEP.md: the wrapper's "create tasks, do not write or commit code"
// and a built-in step prompt ending in "commit your work". A Documentation step
// resolved that the wrong way and committed docs straight to the repo instead of
// filing tasks. Two things prevent a repeat and both are pinned here: the
// shipped prompts no longer say "do the work", and saved copies of the old
// wording are migrated on load.

const migration = (id: string) => {
  const found = DEFAULT_PROMPT_MIGRATIONS.find((m) => m.id === id);
  assert.ok(found, `no migration entry with id ${id}`);
  return found;
};

const step = (over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id: 'step_1',
  title: 'Documentation',
  prompt: '',
  mode: 'sequential',
  harness: 'claude',
  kind: 'agent',
  ...over,
});

// --- the two copies of each built-in prompt must not drift -------------------

test('every quick-add migration mirrors the frontend prompt file byte for byte', () => {
  const quickAdds = DEFAULT_PROMPT_MIGRATIONS.filter((m) => m.id.startsWith('quick-add:'));
  assert.ok(quickAdds.length >= 3);
  for (const m of quickAdds) {
    const name = m.id.slice('quick-add:'.length);
    const file = fileURLToPath(
      new URL(
        `../../../frontend/src/components/workflows/prompts/${name}.md`,
        import.meta.url,
      ),
    );
    const body = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    assert.equal(
      m.current,
      body,
      `${m.id}.current drifted from ${name}.md — a migrated workflow would get ` +
        'different wording than a freshly created one',
    );
  }
});

test('no current built-in prompt tells the agent to do the work itself', () => {
  // The exact failure mode: a shipped prompt whose closing line asks for a
  // commit, contradicting the planner-only wrapper.
  const banned = /commit your work|commit the file|commit when|commit it\./i;
  for (const m of DEFAULT_PROMPT_MIGRATIONS) {
    assert.ok(
      !banned.test(m.current),
      `${m.id}.current still instructs the agent to commit: ${m.current.slice(0, 80)}…`,
    );
    // ...and every legacy body it replaces genuinely was one of those, so the
    // entry is pulling its weight rather than churning identical text.
    for (const legacy of m.legacy) assert.notEqual(legacy, m.current);
  }
});

// --- prefix matching --------------------------------------------------------

test('a saved prompt is upgraded while its appended suffix survives', () => {
  const docs = migration('quick-add:documentation');
  const suffix = '\n\n{{user_instructions}}';
  assert.equal(
    migrateDefaultPromptText(docs.legacy[0] + suffix),
    docs.current + suffix,
  );

  // Project-aware chips append a tailoring block BEFORE the variable token.
  const refactor = migration('quick-add:refactor');
  const tailored =
    '\n\n## Active project tailoring\n\nThis active project appears to be React.' +
    '\n\n{{user_instructions}}';
  assert.equal(
    migrateDefaultPromptText(refactor.legacy[0] + tailored),
    refactor.current + tailored,
  );
});

test('migration is idempotent and CRLF-tolerant', () => {
  const docs = migration('quick-add:documentation');
  const once = migrateDefaultPromptText(docs.legacy[0]);
  assert.equal(migrateDefaultPromptText(once), once);
  assert.equal(migrateDefaultPromptText(docs.current), docs.current);
  assert.equal(
    migrateDefaultPromptText(docs.legacy[0].replace(/\n/g, '\r\n')),
    docs.current,
  );
});

test('a hand-edited or unrelated prompt is never touched', () => {
  const docs = migration('quick-add:documentation');
  // One character changed inside the legacy body → no longer a built-in copy.
  const edited = docs.legacy[0].replace('Survey', 'survey');
  assert.equal(migrateDefaultPromptText(edited), edited);
  const custom = 'Do the thing described above and tell me what you found.';
  assert.equal(migrateDefaultPromptText(custom), custom);
  assert.equal(migrateDefaultPromptText(''), '');
});

test('older generations of the same prompt migrate too', () => {
  // The Refactor chip has shipped in three wordings; the oldest must still land
  // on the newest, not just the immediately-previous one.
  const refactor = migration('quick-add:refactor');
  assert.ok(refactor.legacy.length >= 2);
  for (const legacy of refactor.legacy) {
    assert.equal(migrateDefaultPromptText(legacy), refactor.current);
  }
});

test('built-in workflow-template steps migrate as well as quick-add chips', () => {
  const implement = migration('template-step:implement');
  assert.match(implement.legacy[0], /implement it\. Commit your work\./);
  assert.equal(migrateDefaultPromptText(implement.legacy[0]), implement.current);
});

// --- the collection helpers report change accurately -------------------------

test('migrateWorkflowStepPrompts reports change and preserves identity otherwise', () => {
  const docs = migration('quick-add:documentation');
  const untouched = [step({ prompt: 'custom' }), step({ id: 'step_2', prompt: '' })];
  const same = migrateWorkflowStepPrompts(untouched);
  assert.equal(same.changed, false);
  assert.equal(same.steps, untouched, 'unchanged input must be returned by reference');

  const stale = [step({ prompt: docs.legacy[0] }), step({ id: 'step_2', prompt: 'custom' })];
  const migrated = migrateWorkflowStepPrompts(stale);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.steps[0].prompt, docs.current);
  assert.equal(migrated.steps[1], stale[1], 'a clean step keeps its object identity');
  assert.equal(stale[0].prompt, docs.legacy[0], 'input must not be mutated in place');
});

test('migrateWorkflowDefaultPrompts walks every workflow', () => {
  const docs = migration('quick-add:documentation');
  const workflows: Workflow[] = [
    {
      id: 'wf_a',
      projectPath: 'C:/p',
      name: 'clean',
      steps: [step({ prompt: 'custom' })],
      variables: [],
      createdAt: 1,
    },
    {
      id: 'wf_b',
      projectPath: 'C:/p',
      name: 'stale',
      steps: [step({ prompt: docs.legacy[0] })],
      variables: [],
      createdAt: 2,
    },
  ];
  const result = migrateWorkflowDefaultPrompts(workflows);
  assert.equal(result.changed, true);
  assert.equal(result.workflows[0], workflows[0]);
  assert.equal(result.workflows[1].steps[0].prompt, docs.current);

  const clean = migrateWorkflowDefaultPrompts([workflows[0]]);
  assert.equal(clean.changed, false);
});

// --- the rendered brief itself ----------------------------------------------

function renderClaudeStep(prompt: string): string {
  const wf: Workflow = {
    id: 'wf_1',
    projectPath: 'C:/dev/app',
    name: 'flow',
    steps: [step({ title: 'Documentation', prompt })],
    variables: [],
    createdAt: 1,
  };
  const run: WorkflowRun = {
    id: 'wfrun_1',
    workflowId: wf.id,
    workflowName: wf.name,
    projectPath: wf.projectPath,
    status: 'running',
    startedAt: 1,
    totalSteps: 1,
    currentStepIndex: 0,
  };
  return renderStepMarkdown(wf, run, 0, 'http://127.0.0.1:5184');
}

test('WORKFLOW_STEP.md states the planner-only rule above the step prompt', () => {
  const md = renderClaudeStep('Bring the docs up to a high standard and commit your work.');
  const ruleAt = md.indexOf('you are planning, not implementing');
  const promptAt = md.indexOf('Bring the docs up to a high standard');
  assert.ok(ruleAt > 0, 'planner-only heading missing');
  assert.ok(ruleAt < promptAt, 'the rule must be readable before the step prompt');
  assert.match(md, /overrides the step prompt below/);
  assert.match(md, /Do not create, edit, or delete any file in the project/);
});

test("Claude's completion line does not hinge on the step prompt listing tasks", () => {
  // The old wording ("After creating all the tasks described above, simply
  // stop") read as unfilled boilerplate to a step whose prompt named no tasks,
  // which is the reasoning that let the agent dismiss the whole footer.
  const md = renderClaudeStep('Survey the docs.');
  assert.doesNotMatch(md, /After creating all the tasks described above/);
  assert.match(md, /concluded that none are needed/);
});

test('the brief points at the full API reference and the update/delete calls', () => {
  const md = renderClaudeStep('Combine overlapping tasks.');
  assert.match(md, /\.lattice[\\/]LATTICE_API\.md/);
  assert.match(md, /-X DELETE "http:\/\/127\.0\.0\.1:5184\/api\/tasks\/<id>"/);
  assert.match(md, /-X PATCH "http:\/\/127\.0\.0\.1:5184\/api\/tasks\/<id>"/);
});
