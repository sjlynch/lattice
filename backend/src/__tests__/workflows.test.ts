import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { flushProjectNotifications } from '../projectStateManager.js';
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
import { DEFAULT_PROMPT_MIGRATIONS } from '../workflows/defaultPromptMigrations.js';
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
    // Subscriber fan-out is coalesced per project and delivered a turn later.
    await flushProjectNotifications();
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

test('loading a project upgrades stale built-in step prompts and persists the result', async () => {
  // A workflow stores a plain copy of the quick-add prompt text, so rewording a
  // shipped built-in never reaches an already-saved workflow on its own. The
  // rewording this migrates for is a correctness fix (the old Documentation
  // prompt ended in "commit your work", contradicting WORKFLOW_STEP.md's
  // planner-only contract), so it has to reach saved workflows too.
  const docs = DEFAULT_PROMPT_MIGRATIONS.find((m) => m.id === 'quick-add:documentation');
  assert.ok(docs);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-workflows-migrate-'));
  try {
    const project = canonicalProjectPath(dir);
    const file = workflowsFile(project);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const stale: Workflow[] = [
      {
        id: 'wf_stale',
        projectPath: project,
        name: 'Docs',
        steps: [
          {
            id: 'step_docs',
            title: 'Documentation',
            // Exactly what the editor persisted: the built-in body plus the
            // appended variable token.
            prompt: `${docs.legacy[0]}\n\n{{user_instructions}}`,
            mode: 'sequential',
            harness: 'claude',
            kind: 'agent',
          },
          {
            id: 'step_custom',
            title: 'Mine',
            prompt: 'Something I wrote myself.',
            mode: 'sequential',
            harness: 'claude',
            kind: 'agent',
          },
        ],
        variables: [],
        createdAt: 1,
      },
    ];
    await fs.writeFile(file, JSON.stringify(stale), 'utf8');

    const store = new WorkflowStore();
    const loaded = await store.listWorkflows(dir);
    assert.equal(loaded[0].steps[0].prompt, `${docs.current}\n\n{{user_instructions}}`);
    assert.equal(loaded[0].steps[1].prompt, 'Something I wrote myself.');

    // ...and the upgrade is written back, not just held in memory.
    await store.flushPersist(dir);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as Workflow[];
    assert.equal(onDisk[0].steps[0].prompt, `${docs.current}\n\n{{user_instructions}}`);
    assert.doesNotMatch(onDisk[0].steps[0].prompt, /commit your work/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a stale built-in prompt from an older frontend bundle is migrated on create', async () => {
  const docs = DEFAULT_PROMPT_MIGRATIONS.find((m) => m.id === 'quick-add:documentation');
  assert.ok(docs);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-workflows-migrate-create-'));
  try {
    const store = new WorkflowStore();
    const created = await store.createWorkflow(dir, 'Docs', [
      {
        id: 'step_docs',
        title: 'Documentation',
        prompt: docs.legacy[0],
        mode: 'sequential',
        harness: 'claude',
        kind: 'agent',
      },
    ]);
    assert.equal(created.steps[0].prompt, docs.current);

    const patched = await store.updateWorkflow(created.id, {
      steps: [{ ...created.steps[0], prompt: docs.legacy[0] }],
    });
    assert.ok(patched);
    assert.equal(patched.steps[0].prompt, docs.current);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('getWorkflow/updateWorkflow/deleteWorkflow resolve by id with an empty cache (post-restart)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-workflows-restart-'));
  try {
    const project = canonicalProjectPath(dir);
    // The known-projects source is the only thing pointing a fresh store at a
    // project it hasn't loaded yet — mirror the global tasks index by handing
    // it this project explicitly.
    const knownProjects = async () => [project];

    const seeder = new WorkflowStore({ listKnownProjects: knownProjects });
    const created = await seeder.createWorkflow(dir, 'Restart Flow', [
      { id: 'step_one', title: 'Only', prompt: 'Do it', mode: 'sequential', harness: 'claude' },
    ]);
    await seeder.flushPersist(dir);

    // A fresh store stands in for the post-restart process: its in-memory cache
    // is empty and the project was never loaded this "session". Each by-id
    // operation must still resolve the workflow off disk.
    const afterRestartGet = new WorkflowStore({ listKnownProjects: knownProjects });
    const got = await afterRestartGet.getWorkflow(created.id);
    assert.ok(got, 'getWorkflow should resolve a workflow whose project is not loaded');
    assert.equal(got.id, created.id);
    assert.equal(got.name, 'Restart Flow');

    const afterRestartPatch = new WorkflowStore({ listKnownProjects: knownProjects });
    const patched = await afterRestartPatch.updateWorkflow(created.id, { name: 'Renamed After Restart' });
    assert.ok(patched, 'updateWorkflow should resolve a workflow whose project is not loaded');
    assert.equal(patched.name, 'Renamed After Restart');
    await afterRestartPatch.flushPersist(dir);
    assert.equal(
      (JSON.parse(await fs.readFile(workflowsFile(project), 'utf8')) as Workflow[])[0].name,
      'Renamed After Restart',
    );

    const afterRestartDelete = new WorkflowStore({ listKnownProjects: knownProjects });
    assert.equal(
      await afterRestartDelete.deleteWorkflow(created.id),
      true,
      'deleteWorkflow should resolve a workflow whose project is not loaded',
    );
    await afterRestartDelete.flushPersist(dir);
    assert.deepEqual(JSON.parse(await fs.readFile(workflowsFile(project), 'utf8')), []);

    // A genuinely unknown id still resolves to null/false, not a throw.
    const empty = new WorkflowStore({ listKnownProjects: knownProjects });
    assert.equal(await empty.getWorkflow('wf_missing'), null);
    assert.equal(await empty.deleteWorkflow('wf_missing'), false);
    assert.equal(await empty.updateWorkflow('wf_missing', { name: 'x' }), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
