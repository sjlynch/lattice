// Task agents run no tests / builds / type-checks by default
// (taskVerification.ts): the rule must reach them through the brief AND the
// system prompt, override-proof, and only for task-worktree spawns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderTaskMarkdown } from '../worktree/instructions/taskPrompt.js';
import { renderMergeInstructions } from '../worktree/instructions/mergePrompt.js';
import { resolveHarnessSpawnBody } from '../terminalServerClient/createSession.js';
import {
  renderVerificationBlock,
  renderVerificationSystemPrompt,
} from '../taskVerification.js';

assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run with the isolateHome preload');

const task = {
  id: 't_verify', projectPath: process.cwd(), title: 'Verify', status: 'in_progress' as const, createdAt: 0,
};
const origin = 'http://127.0.0.1:5199';
const LEFTOVER_TOKEN = /\{\{\s*\w+\s*\}\}/;

test('the default task and merge briefs carry the no-verification rule', () => {
  for (const harness of ['claude', 'pi', 'codex'] as const) {
    const brief = renderTaskMarkdown(task, origin, harness);
    assert.ok(brief.includes(renderVerificationBlock(false)), harness);
    assert.match(brief, /overrides any CLAUDE\.md or AGENTS\.md/);
    assert.doesNotMatch(brief, LEFTOVER_TOKEN);
  }
  const merge = renderMergeInstructions(task, 'lattice/x', ['a.ts'], origin, '');
  assert.ok(merge.includes(renderVerificationBlock(false)));
  assert.doesNotMatch(merge, LEFTOVER_TOKEN);
});

test('the type-check setting swaps in the "type-check only" wording', () => {
  const brief = renderTaskMarkdown(task, origin, 'claude', [], null, undefined, true);
  assert.ok(brief.includes(renderVerificationBlock(true)));
  assert.match(brief, /may run a type-check limited to the package\(s\) you edited/);
  assert.doesNotMatch(renderVerificationBlock(false), /may run a type-check/);
});

test('a custom brief without the token still gets the rule, once', () => {
  const withToken = renderTaskMarkdown(task, origin, 'claude', [], null, '# {{task_title}}\n{{verification}}end');
  assert.equal(withToken.split(renderVerificationBlock(false)).length, 2);
  const merge = renderMergeInstructions(task, 'b', [], origin, '', 'Resolve {{task_id}}.');
  assert.ok(merge.startsWith('Resolve t_verify.'));
  assert.ok(merge.includes(renderVerificationBlock(false)));
});

test('the system-prompt form is one line with no double quotes (Codex -c over cmd.exe)', () => {
  for (const typecheck of [false, true]) {
    const line = renderVerificationSystemPrompt(typecheck);
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
  assert.ok(text.includes(renderVerificationSystemPrompt(true)));

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
  assert.ok(dev?.includes(renderVerificationSystemPrompt(false)), dev);
});
