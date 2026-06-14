import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import {
  ensureUserInstructions,
  normalizeSteps,
  normalizeVariables,
  normalizeWorkflowRunHarnessOverride,
  normalizeWorkflowStepHarness,
  normalizeWorkflows,
  USER_INSTRUCTIONS_VAR,
} from '../workflows/normalization.js';
import { interpolateWorkflowVariables } from '../workflows/interpolate.js';
import {
  WORKFLOWS_FILENAME,
  WorkflowStore,
  workflowsFile,
} from '../workflows/store.js';
import type { Workflow, WorkflowStep } from '../workflows.js';

test('workflow normalization applies persisted fallbacks and harness defaults', () => {
  const project = canonicalProjectPath(path.join(os.tmpdir(), 'lattice-workflows-project'));
  const embeddedProject = path.join(project, 'embedded');

  const normalized = normalizeWorkflows(
    [
      {
        id: 'wf_existing',
        projectPath: embeddedProject,
        name: '  Named flow  ',
        createdAt: 123,
        steps: [
          {
            id: 'step_existing',
            title: 'Existing step',
            prompt: 'Do the thing',
            mode: 'parallel',
            harness: 'pi',
            extra: 'kept',
          },
          {
            title: 42,
            prompt: null,
            mode: 'invalid',
            harness: 'unknown',
          },
        ],
      },
      {
        name: '   ',
      },
    ],
    project,
  );

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].id, 'wf_existing');
  assert.equal(normalized[0].projectPath, canonicalProjectPath(embeddedProject));
  assert.equal(normalized[0].name, 'Named flow');
  assert.equal(normalized[0].createdAt, 123);
  assert.equal(normalized[0].steps[0].mode, 'parallel');
  assert.equal(normalized[0].steps[0].harness, 'pi');
  assert.equal((normalized[0].steps[0] as WorkflowStep & { extra?: string }).extra, 'kept');
  assert.match(normalized[0].steps[1].id, /^step_\d+_1_[a-z0-9]{3}$/);
  assert.equal(normalized[0].steps[1].title, '');
  assert.equal(normalized[0].steps[1].prompt, '');
  assert.equal(normalized[0].steps[1].mode, 'sequential');
  assert.equal(normalized[0].steps[1].harness, 'claude');

  assert.match(normalized[1].id, /^wf_\d+_[a-z0-9]{5}$/);
  assert.equal(normalized[1].projectPath, project);
  assert.equal(normalized[1].name, 'Untitled workflow');
  assert.equal(typeof normalized[1].createdAt, 'number');
  assert.deepEqual(normalized[1].steps, []);

  assert.equal(normalizeWorkflowStepHarness('codex'), 'codex');
  assert.equal(normalizeWorkflowStepHarness('bogus'), 'claude');
  assert.equal(normalizeWorkflowRunHarnessOverride('pi'), 'pi');
  assert.equal(normalizeWorkflowRunHarnessOverride('bogus'), null);
  assert.equal(normalizeWorkflowRunHarnessOverride(null), null);
  assert.deepEqual(normalizeSteps(undefined), []);
});

test('workflow variable normalization sanitizes names, dedupes, and guarantees user_instructions', () => {
  const project = canonicalProjectPath(path.join(os.tmpdir(), 'lattice-workflow-vars'));

  // No variables on disk → user_instructions is injected as an empty default.
  const [withDefault] = normalizeWorkflows([{ id: 'wf_a', steps: [] }], project);
  assert.equal(withDefault.variables.length, 1);
  assert.equal(withDefault.variables[0].name, USER_INSTRUCTIONS_VAR);
  assert.equal(withDefault.variables[0].value, '');

  // Names are sanitized to the {{name}} grammar; blanks/dupes are dropped.
  const cleaned = normalizeVariables([
    { id: 'v1', name: '  Spaced Name!! ', value: 'a' },
    { name: '', value: 'ignored-blank' },
    { name: 'dup', value: 'first' },
    { name: 'dup', value: 'second-dropped' },
  ]);
  assert.deepEqual(
    cleaned.map((v) => v.name),
    ['Spaced_Name', 'dup'],
  );
  assert.equal(cleaned[1].value, 'first');

  // ensureUserInstructions is idempotent and leads with the built-in.
  const ensured = ensureUserInstructions(cleaned);
  assert.equal(ensured[0].name, USER_INSTRUCTIONS_VAR);
  assert.equal(ensureUserInstructions(ensured).length, ensured.length);
});

test('interpolateWorkflowVariables replaces known refs and leaves unknown ones intact', () => {
  const vars = [
    { id: 'v1', name: 'user_instructions', value: 'Be terse.' },
    { id: 'v2', name: 'scope', value: 'frontend only' },
  ];
  assert.equal(
    interpolateWorkflowVariables('Do the work.\n\n{{user_instructions}}', vars),
    'Do the work.\n\nBe terse.',
  );
  // Whitespace inside braces is tolerated; unknown vars pass through.
  assert.equal(
    interpolateWorkflowVariables('{{ scope }} and {{unknown}}', vars),
    'frontend only and {{unknown}}',
  );
  // An empty value collapses its reference to nothing.
  assert.equal(
    interpolateWorkflowVariables('x{{empty}}y', [{ id: 'e', name: 'empty', value: '' }]),
    'xy',
  );
});

test('WorkflowStore persists workflows under .lattice/workflows.json and reloads harness choices', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-workflows-store-'));
  try {
    const store = new WorkflowStore();
    const events: Array<{ projectPath: string; workflows: Workflow[] }> = [];
    const unsubscribe = store.subscribe((projectPath, workflows) => {
      events.push({ projectPath, workflows });
    });

    const created = await store.createWorkflow(dir, '  Test Flow  ', [
      {
        id: '',
        title: 'First',
        prompt: 'Do it',
        mode: 'parallel',
        harness: 'codex',
      },
      {
        id: 'step_two',
        title: 'Second',
        prompt: 'Do it again',
        mode: 'sequential',
        harness: 'pi',
      },
    ]);
    unsubscribe();

    const project = canonicalProjectPath(dir);
    assert.equal(created.projectPath, project);
    assert.equal(created.name, 'Test Flow');
    assert.match(created.id, /^wf_\d+_[a-z0-9]{5}$/);
    assert.match(created.steps[0].id, /^step_\d+_0_[a-z0-9]{3}$/);
    assert.equal(created.steps[0].mode, 'parallel');
    assert.equal(created.steps[0].harness, 'codex');
    assert.equal(created.steps[1].harness, 'pi');

    assert.equal(events.length, 1);
    assert.equal(events[0].projectPath, project);
    assert.equal(events[0].workflows.length, 1);
    events[0].workflows.length = 0;
    assert.equal((await store.listWorkflows(dir)).length, 1);

    await store.flushPersist(dir);
    const file = workflowsFile(project);
    assert.equal(path.basename(file), WORKFLOWS_FILENAME);
    assert.equal(path.basename(path.dirname(file)), '.lattice');

    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as Workflow[];
    assert.equal(saved.length, 1);
    assert.equal(saved[0].projectPath, project);
    assert.equal(saved[0].steps[0].harness, 'codex');
    assert.equal(saved[0].steps[1].harness, 'pi');

    const reloaded = new WorkflowStore();
    const listed = await reloaded.listWorkflows(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].steps[0].harness, 'codex');
    assert.equal(listed[0].steps[1].harness, 'pi');

    const updated = await reloaded.updateWorkflow(created.id, {
      name: '  Renamed  ',
      steps: [
        {
          id: 'step_kept',
          title: 'Kept',
          prompt: 'Use pi',
          mode: 'sequential',
          harness: 'pi',
        },
      ],
    });
    assert.ok(updated);
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.steps[0].harness, 'pi');
    await reloaded.flushPersist(dir);

    const savedUpdated = JSON.parse(await fs.readFile(file, 'utf8')) as Workflow[];
    assert.equal(savedUpdated[0].name, 'Renamed');
    assert.equal(savedUpdated[0].steps[0].harness, 'pi');

    assert.equal(await reloaded.deleteWorkflow(created.id), true);
    await reloaded.flushPersist(dir);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
