import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  startStepTaskPiModel,
  resolveStartStepHarnessPicker,
} from '../workflowRuns/controlSteps/start.js';
import { buildPiCommand } from '../worktree/commands.js';
import { patchUserSettings } from '../userSettings.js';

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

// Regression for: "workflow Start control step ignores the per-project default
// harness, forcing Claude when the run has no harness override." With no
// run-level override the Start step must use the project's DEFAULT harness
// (UserSettings.harness / piModel) — exactly like the Task Board "Run All"
// button — instead of hardcoding Claude. (Distinct from the override-case bug
// above.)

async function mkProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-startstep-'));
}

const noOverride = { harnessOverride: undefined, piModelOverride: undefined };

test('Start step uses the per-project default harness when the run has no override', async () => {
  const project = await mkProject();
  try {
    await patchUserSettings(project, { harness: 'pi', piModel: 'vllm/qwen' });
    const pick = await resolveStartStepHarnessPicker(noOverride, project);
    // A project defaulting to Pi must spawn its workflow-started tasks on Pi
    // (with the project's default model) — not the forced Claude of the bug.
    assert.deepEqual(pick(0), { harness: 'pi', piModel: 'vllm/qwen' });
    assert.deepEqual(pick(3), { harness: 'pi', piModel: 'vllm/qwen' });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('Start step default codex harness is honored and never pins a Pi model', async () => {
  const project = await mkProject();
  try {
    // A stray piModel must not leak onto a non-pi default harness.
    await patchUserSettings(project, { harness: 'codex', piModel: 'vllm/qwen' });
    const pick = await resolveStartStepHarnessPicker(noOverride, project);
    assert.deepEqual(pick(0), { harness: 'codex', piModel: undefined });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('Start step with no settings (and no override) falls back to Claude', async () => {
  const project = await mkProject();
  try {
    const pick = await resolveStartStepHarnessPicker(noOverride, project);
    assert.deepEqual(pick(0), { harness: 'claude', piModel: undefined });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('Start step expands the default interleave harness like the UI (claude/pi by task)', async () => {
  const project = await mkProject();
  try {
    await patchUserSettings(project, { harness: 'interleave', piModel: 'vllm/qwen' });
    const pick = await resolveStartStepHarnessPicker(noOverride, project);
    // Alternates starting on claude; Pi picks carry the project's default model.
    assert.deepEqual(pick(0), { harness: 'claude', piModel: undefined });
    assert.deepEqual(pick(1), { harness: 'pi', piModel: 'vllm/qwen' });
    assert.deepEqual(pick(2), { harness: 'claude', piModel: undefined });
    assert.deepEqual(pick(3), { harness: 'pi', piModel: 'vllm/qwen' });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('Start step run-level override still pins every task (and beats the project default)', async () => {
  const project = await mkProject();
  try {
    // Project defaults to Pi, but the run overrides to Claude → Claude wins.
    await patchUserSettings(project, { harness: 'pi', piModel: 'vllm/qwen' });
    const pick = await resolveStartStepHarnessPicker(
      { harnessOverride: 'claude', piModelOverride: undefined },
      project,
    );
    assert.deepEqual(pick(0), { harness: 'claude', piModel: undefined });

    // A Pi override carries its own model override, not the project default.
    const piPick = await resolveStartStepHarnessPicker(
      { harnessOverride: 'pi', piModelOverride: 'qwen-local/qwen' },
      project,
    );
    assert.deepEqual(piPick(0), { harness: 'pi', piModel: 'qwen-local/qwen' });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
