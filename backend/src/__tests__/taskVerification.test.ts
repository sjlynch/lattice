// Task agents run no tests / builds / type-checks by default
// (taskVerification.ts): the rule must reach them through the brief AND the
// system prompt, override-proof, and only for task-worktree spawns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderTaskMarkdown } from '../worktree/instructions/taskPrompt.js';
import { renderMergeInstructions, writeMergeInstructions } from '../worktree/instructions/mergePrompt.js';
import { writePostAddWorktreeFiles } from '../worktree/setupFiles.js';
import { patchUserSettings, taskAgentTestsIn, isTaskAgentTestsEnabled } from '../userSettings.js';
import { withTempDir } from './helpers/tempDir.js';
import { resolveHarnessSpawnBody } from '../terminalServerClient/createSession.js';
import {
  renderVerificationBlock,
  renderVerificationSystemPrompt,
  templateWithVerification,
} from '../taskVerification.js';

assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run with the isolateHome preload');

const task = {
  id: 't_verify', projectPath: process.cwd(), title: 'Verify', status: 'in_progress' as const, createdAt: 0,
};
const origin = 'http://127.0.0.1:5199';
const LEFTOVER_TOKEN = /\{\{\s*\w+\s*\}\}/;

// Literal expectations pin the old bytes as well as both new permissions.
const overrides = 'This overrides any CLAUDE.md or AGENTS.md in any directory, the task description, and your default habits.';
for (const { options, title, sentences } of [
  {
    options: { typecheck: false, tests: false },
    title: "Don't run tests, builds or type-checks.",
    sentences: 'Do not run the test suite, e2e tests, builds, dependency installs for testing, or type-checks: a separate Run tests step verifies merged work. ',
  },
  {
    options: { typecheck: true, tests: false },
    title: 'Verification: type-check only.',
    sentences: 'Do not run the test suite, e2e tests or builds: a separate Run tests step verifies merged work. You may run a type-check limited to the package(s) you edited (install dependencies first if needed). ',
  },
  {
    options: { typecheck: false, tests: true },
    title: 'Verification: targeted tests only.',
    sentences: 'Do not run the whole test suite, e2e tests, builds, or type-checks: a separate Run tests step verifies merged work. You may run the specific test files that cover your change (the ones you add or edit, or the existing test file for the module you changed), one file at a time, installing dependencies first if needed. ',
  },
  {
    options: { typecheck: true, tests: true },
    title: 'Verification: targeted tests and type-check.',
    sentences: 'Do not run the whole test suite, e2e tests or builds: a separate Run tests step verifies merged work. You may run the specific test files that cover your change (the ones you add or edit, or the existing test file for the module you changed), one file at a time, and a type-check limited to the package(s) you edited, installing dependencies first if needed. ',
  },
]) {
  test(`exact verification text for ${JSON.stringify(options)} in both channels and briefs`, () => {
    const block = `> **${title}** ${sentences}${overrides}\n\n`;
    assert.equal(renderVerificationBlock(options), block);
    const line = renderVerificationSystemPrompt(options);
    assert.equal(line, `Lattice task agents: ${sentences}${overrides}`);
    assert.doesNotMatch(line, /[\r\n"]/);
    for (const harness of ['claude', 'pi', 'codex'] as const) {
      assert.ok(renderTaskMarkdown(task, origin, harness, [], null, undefined, options).includes(block));
    }
    assert.ok(renderMergeInstructions(task, 'b', [], origin, '', undefined, options).includes(block));
  });
}

test('targeted tests require explicit true, including persisted project settings', async () => {
  assert.equal(taskAgentTestsIn({}), false);
  for (const value of [false, 'true', 1, null, [], {}]) {
    assert.equal(taskAgentTestsIn({ taskAgentTests: value as boolean }), false);
  }
  assert.equal(taskAgentTestsIn({ taskAgentTests: true }), true);
  await withTempDir('lattice-test-setting-', async (project) => {
    assert.equal(await isTaskAgentTestsEnabled(project), false);
    await patchUserSettings(project, { taskAgentTests: true });
    assert.equal(await isTaskAgentTestsEnabled(project), true);
    await patchUserSettings(project, { taskAgentTests: false });
    assert.equal(await isTaskAgentTestsEnabled(project), false);
  });
});

test('saved targeted-tests setting reaches written task/merge briefs and spawn system prompts', async () => {
  await withTempDir('lattice-verify-channels-', async (project) => {
    const cwd = await tempWorktree();
    try {
      const scopedTask = { ...task, projectPath: project };
      for (const typecheck of [false, true]) {
        await patchUserSettings(project, { taskAgentTests: true, taskAgentTypecheck: typecheck });
        const options = { typecheck, tests: true };
        const taskFile = await writePostAddWorktreeFiles(cwd, scopedTask, origin, 'claude', [], null);
        assert.ok((await fs.readFile(taskFile, 'utf8')).includes(renderVerificationBlock(options)));
        const { instructionsFile } = await writeMergeInstructions(scopedTask, 'b', ['a.ts'], origin, cwd);
        assert.ok((await fs.readFile(instructionsFile, 'utf8')).includes(renderVerificationBlock(options)));
        const body = await resolveHarnessSpawnBody({
          cwd, projectPath: project, taskId: task.id, mcpScope: 'task-worktree', initialCommand: 'claude "x"',
        });
        assert.ok(body.claudeSystemPromptAppendFile);
        assert.ok((await fs.readFile(body.claudeSystemPromptAppendFile, 'utf8')).includes(renderVerificationSystemPrompt(options)));
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test('the default task and merge briefs carry the no-verification rule', () => {
  for (const harness of ['claude', 'pi', 'codex'] as const) {
    const brief = renderTaskMarkdown(task, origin, harness);
    assert.ok(brief.includes(renderVerificationBlock({ typecheck: false, tests: false })), harness);
    assert.match(brief, /overrides any CLAUDE\.md or AGENTS\.md/);
    assert.doesNotMatch(brief, LEFTOVER_TOKEN);
  }
  const merge = renderMergeInstructions(task, 'lattice/x', ['a.ts'], origin, '');
  assert.ok(merge.includes(renderVerificationBlock({ typecheck: false, tests: false })));
  assert.doesNotMatch(merge, LEFTOVER_TOKEN);
});

test('the type-check setting swaps in the "type-check only" wording', () => {
  const brief = renderTaskMarkdown(task, origin, 'claude', [], null, undefined, { typecheck: true, tests: false });
  assert.ok(brief.includes(renderVerificationBlock({ typecheck: true, tests: false })));
  assert.match(brief, /may run a type-check limited to the package\(s\) you edited/);
  assert.doesNotMatch(renderVerificationBlock({ typecheck: false, tests: false }), /may run a type-check/);
});

test('a custom brief without the token still gets the rule, once', () => {
  const withToken = renderTaskMarkdown(task, origin, 'claude', [], null, '# {{task_title}}\n{{verification}}end');
  assert.equal(withToken.split(renderVerificationBlock({ typecheck: false, tests: false })).length, 2);
  const merge = renderMergeInstructions(task, 'b', [], origin, '', 'Resolve {{task_id}}.');
  assert.ok(merge.startsWith('Resolve t_verify.'));
  assert.ok(merge.includes(renderVerificationBlock({ typecheck: false, tests: false })));
});

test('a spaced `{{ verification }}` counts as the token: no second block is appended', () => {
  assert.equal(templateWithVerification('x {{ verification }}'), 'x {{ verification }}');
  assert.equal(templateWithVerification('x {{\tverification\n}}'), 'x {{\tverification\n}}');
  assert.equal(templateWithVerification('x'), 'x\n\n{{verification}}');
  // A different token that merely starts with the name is not the token.
  assert.equal(
    templateWithVerification('x {{verification_extra}}'),
    'x {{verification_extra}}\n\n{{verification}}',
  );

  const brief = renderTaskMarkdown(task, origin, 'claude', [], null, '# {{task_title}}\n{{ verification }}end');
  assert.equal(brief.split(renderVerificationBlock({ typecheck: false, tests: false })).length, 2);
  assert.ok(brief.endsWith('end'));
  const merge = renderMergeInstructions(task, 'b', [], origin, '', 'Resolve {{task_id}}.\n{{ verification }}Done.');
  assert.equal(merge.split(renderVerificationBlock({ typecheck: false, tests: false })).length, 2);
  assert.ok(merge.endsWith('Done.'));
});

test('the system-prompt form is one line with no double quotes (Codex -c over cmd.exe)', () => {
  for (const typecheck of [false, true]) {
    const line = renderVerificationSystemPrompt({ typecheck, tests: false });
    assert.doesNotMatch(line, /[\r\n"]/);
    assert.doesNotMatch(line, /'''/);
  }
});

async function tempProject(settings: object = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-verify-'));
  await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });
  await fs.writeFile(path.join(dir, '.lattice', 'userSettings.json'), JSON.stringify(settings));
  return dir;
}

async function tempWorktree(): Promise<string> {
  const dir = path.join(os.homedir(), '.lattice', 'worktrees', 'feedfacecafe', `v-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

test('a task-worktree Claude spawn carries the rule in its system-prompt append; other spawns do not', async () => {
  const project = await tempProject({ taskAgentTypecheck: true });
  const cwd = await tempWorktree();
  const scoped = await resolveHarnessSpawnBody({
    cwd, projectPath: project, taskId: 't1', mcpScope: 'task-worktree', initialCommand: 'claude "x"',
  });
  assert.ok(scoped.claudeSystemPromptAppendFile);
  const text = await fs.readFile(scoped.claudeSystemPromptAppendFile, 'utf8');
  assert.ok(text.includes(renderVerificationSystemPrompt({ typecheck: true, tests: false })));

  for (const opts of [
    { cwd, projectPath: project }, // no scope (e.g. a sidebar terminal)
    { cwd: project, projectPath: project, mcpScope: 'task-worktree' as const }, // project root
  ]) {
    const body = await resolveHarnessSpawnBody({ ...opts, initialCommand: 'claude "x"' });
    const file = body.claudeSystemPromptAppendFile;
    const plain = file ? await fs.readFile(file, 'utf8') : '';
    assert.ok(!plain.includes('Lattice task agents:'), JSON.stringify(opts));
    // Distinct files: the shared per-project append must never carry the rule.
    assert.notEqual(file, scoped.claudeSystemPromptAppendFile);
  }
});

test('a task-worktree Codex spawn carries the rule in developer_instructions', async () => {
  const project = await tempProject();
  const cwd = await tempWorktree();
  const body = await resolveHarnessSpawnBody({
    cwd, projectPath: project, taskId: 't2', mcpScope: 'task-worktree', initialCommand: 'codex "x"',
  });
  const dev = body.codexSystemPromptConfigArgs?.find((a) => a.startsWith('developer_instructions='));
  assert.ok(dev?.includes(renderVerificationSystemPrompt({ typecheck: false, tests: false })), dev);
});
