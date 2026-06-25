import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStepTaskPiModel } from '../workflowRuns/controlSteps/start.js';
import { buildPiCommand } from '../worktree/commands.js';

// Regression for: "workflow Start step drops the run-level Pi model override
// for spawned tasks." A workflow launched with harnessOverride:"pi" +
// piModelOverride must spawn its Open tasks on that *same* Pi model — the same
// way regular workflow steps do (effectiveStepPiModel) — instead of silently
// falling back to the project/default model.

test('Start step resolves the run-level Pi model override for spawned task agents', () => {
  // A Pi run with an explicit model override → the start step forwards it.
  const piRun = { harnessOverride: 'pi' as const, piModelOverride: 'qwen-local/qwen' };
  assert.equal(startStepTaskPiModel(piRun), 'qwen-local/qwen');

  // That resolved model is what startTaskById feeds into the Pi command
  // builder, so the spawned agent's command line carries `--model "<override>"`.
  assert.match(
    buildPiCommand('/wt/LATTICE_TASK.md', startStepTaskPiModel(piRun)),
    /--model "qwen-local\/qwen"/,
  );
});

test('Start step leaves the Pi model unset for non-pi runs and pi runs with no override', () => {
  // Claude/codex runs (or a default run with no override) must NOT pin a Pi
  // model — even if a stray piModelOverride is present.
  assert.equal(
    startStepTaskPiModel({ harnessOverride: undefined, piModelOverride: undefined }),
    undefined,
  );
  assert.equal(
    startStepTaskPiModel({ harnessOverride: 'claude', piModelOverride: 'qwen-local/qwen' }),
    undefined,
  );

  // A Pi run with no chosen model → undefined, so the task falls back to the
  // per-project default (no `--model` flag is appended).
  const piNoModel = { harnessOverride: 'pi' as const, piModelOverride: undefined };
  assert.equal(startStepTaskPiModel(piNoModel), undefined);
  assert.doesNotMatch(
    buildPiCommand('/wt/LATTICE_TASK.md', startStepTaskPiModel(piNoModel)),
    /--model/,
  );
});
