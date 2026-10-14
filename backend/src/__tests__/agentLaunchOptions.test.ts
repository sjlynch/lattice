// Model + effort per agent launch: the per-harness flags, their sanitizing,
// and the precedence rules for workflow steps, Start-step tasks and persisted
// runs. Pure units — no spawning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCommand, buildLaunchFlags } from '../agentCommandBuilder.js';
import { normalizeSteps } from '../workflows/normalization.js';
import { effectiveStepLaunch } from '../workflowRuns/stepMarkdown.js';
import { startStepTaskLaunch } from '../workflowRuns/controlSteps/startHarness.js';
import { deserializeWorkflowRun } from '../workflowRuns/runCodec.js';
import { buildWorkflowStepCommand } from '../workflowRuns/commandBuilder.js';
import { parseAgentCommand } from '../terminalRegistry/commandParse.js';
import type { Workflow } from '../workflows.js';
import type { WorkflowRun } from '../workflowRuns/state.js';

test('claude: --model "<m>" --effort <e> before the prompt', () => {
  assert.equal(
    buildAgentCommand({ harness: 'claude', prompt: 'go', model: 'opus', effort: 'xhigh' }),
    'claude --dangerously-skip-permissions --model "opus" --effort xhigh "go"',
  );
  assert.equal(buildLaunchFlags('claude', { model: 'claude-opus-5-5[1m]' }), ' --model "claude-opus-5-5[1m]"');
});

test('codex: -m + model_reasoning_effort (max passes through)', () => {
  assert.equal(
    buildAgentCommand({ harness: 'codex', prompt: 'go', model: 'gpt-5.5', effort: 'max' }),
    'codex --yolo --dangerously-bypass-hook-trust -m "gpt-5.5" -c model_reasoning_effort=max "go"',
  );
  assert.equal(buildLaunchFlags('codex', { effort: 'low' }), ' -c model_reasoning_effort=low');
});

test('pi: effort is --thinking; a Claude/Codex model never reaches Pi', () => {
  assert.equal(
    buildAgentCommand({ harness: 'pi', prompt: 'go', piModel: 'p/m', model: 'opus', effort: 'high' }),
    'pi --approve --model "p/m" --thinking high "go"',
  );
});

test('unsafe or unknown values drop their flag instead of reaching the shell', () => {
  assert.equal(buildLaunchFlags('claude', { model: 'opus" && calc', effort: 'extreme' as never }), '');
  assert.equal(buildLaunchFlags('claude', { model: '-rf' }), '');
  assert.equal(buildLaunchFlags('claude', {}), '');
});

test('the relaunch parser keeps --model / --effort with their values', () => {
  const parsed = parseAgentCommand(
    buildAgentCommand({ harness: 'claude', prompt: 'go', model: 'opus', effort: 'low' }),
    'claude',
  );
  assert.equal(parsed?.prompt?.value, 'go');
  assert.deepEqual(parsed?.positionals, []);
  assert.deepEqual(parsed?.args.map((a) => a.value), ['--dangerously-skip-permissions', '--model', 'opus', '--effort', 'low']);
});

test('step normalization keeps valid model/effort, drops them on Merge steps', () => {
  const [agent, merge, bad] = normalizeSteps([
    { title: 'a', prompt: '', harness: 'claude', model: ' sonnet ', effort: 'high' },
    { title: 'm', prompt: '', harness: 'claude', kind: 'merge', model: 'opus', effort: 'low' },
    { title: 'b', prompt: '', harness: 'claude', model: 'a b', effort: 'turbo' },
  ]);
  assert.equal(agent.model, 'sonnet');
  assert.equal(agent.effort, 'high');
  assert.equal(merge.model, undefined);
  assert.equal(merge.effort, undefined);
  assert.equal(bad.model, undefined);
  assert.equal(bad.effort, undefined);
});

function wfWith(step: Partial<Workflow['steps'][number]>): Workflow {
  return {
    id: 'wf', name: 'wf', projectPath: 'C:/p', createdAt: 0, updatedAt: 0, variables: [],
    steps: normalizeSteps([{ title: 's', prompt: 'p', harness: 'claude', ...step }]),
  } as unknown as Workflow;
}
const runWith = (over: Partial<WorkflowRun> = {}) => ({ ...over }) as WorkflowRun;

test('effectiveStepLaunch: run overrides win; a step model needs its own harness', () => {
  const wf = wfWith({ model: 'sonnet', effort: 'medium' });
  assert.deepEqual(effectiveStepLaunch(wf, runWith(), 0), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(
    effectiveStepLaunch(wf, runWith({ effortOverride: 'xhigh', agentModelOverride: 'opus' }), 0),
    { model: 'opus', effort: 'xhigh' },
  );
  // Overridden to Codex: the step's Claude model no longer applies; effort does.
  assert.deepEqual(effectiveStepLaunch(wf, runWith({ harnessOverride: 'codex' }), 0), { model: undefined, effort: 'medium' });
  assert.deepEqual(effectiveStepLaunch(wf, runWith({ harnessOverride: 'pi', agentModelOverride: 'opus' }), 0), { model: undefined, effort: 'medium' });
});

test('a step command carries its launch flags (and --add-dir for Run tests)', () => {
  assert.equal(
    buildWorkflowStepCommand('C:/s/WORKFLOW_STEP.md', 'claude', undefined, undefined, { launch: { effort: 'xhigh' } }),
    'claude --dangerously-skip-permissions --effort xhigh "Please read WORKFLOW_STEP.md and complete the task described in it."',
  );
  const withDir = buildWorkflowStepCommand('C:/s/RUN_TESTS.md', 'claude', undefined, undefined, {
    claudeAddDir: 'C:/proj',
    launch: { model: 'sonnet' },
  });
  assert.match(withDir, /^claude --dangerously-skip-permissions --add-dir=\S+ --model "sonnet" "Please read RUN_TESTS\.md/);
});

test('startStepTaskLaunch: run overrides, else the Start step', () => {
  assert.deepEqual(startStepTaskLaunch(runWith(), { model: 'opus', effort: 'medium' }), { model: 'opus', effort: 'medium' });
  assert.deepEqual(startStepTaskLaunch(runWith({ effortOverride: 'low' }), { effort: 'medium' }), { model: undefined, effort: 'low' });
  assert.deepEqual(startStepTaskLaunch(runWith(), undefined), { model: undefined, effort: undefined });
});

test('a persisted run re-validates its effort / model overrides', () => {
  const base = { id: 'wr_1', workflowId: 'wf', projectPath: process.cwd(), startedAt: 1, totalSteps: 1, currentStepIndex: 0, status: 'running' };
  const ok = deserializeWorkflowRun({ ...base, effortOverride: 'max', agentModelOverride: 'fable' });
  assert.equal(ok?.effortOverride, 'max');
  assert.equal(ok?.agentModelOverride, 'fable');
  const bad = deserializeWorkflowRun({ ...base, effortOverride: 'ultra', agentModelOverride: 'x;rm' });
  assert.equal(bad?.effortOverride, undefined);
  assert.equal(bad?.agentModelOverride, undefined);
});
