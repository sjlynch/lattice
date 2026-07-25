import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  pruneOldWorkflowRuns,
  writeScratchReadme,
} from '../workflowRuns/stepSpawner.js';
import { getRunningRunIds, runs, type WorkflowRun } from '../workflowRuns/state.js';
import { canonicalProjectPath } from '../projectPath.js';

async function mkScratchTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-workflow-prune-'));
}

async function touchDir(parent: string, name: string, mtimeMs: number): Promise<string> {
  const p = path.join(parent, name);
  await fs.mkdir(p, { recursive: true });
  // Drop a token file so we can confirm the dir really got deleted.
  await fs.writeFile(path.join(p, 'marker.txt'), 'present', 'utf8');
  const t = new Date(mtimeMs);
  await fs.utimes(p, t, t);
  return p;
}

test('writeScratchReadme: writes a README.md tagged as scratch', async () => {
  const tmp = await mkScratchTmpDir();
  try {
    const runDir = path.join(tmp, 'wfrun_123_abc');
    await fs.mkdir(runDir, { recursive: true });
    await writeScratchReadme(runDir);
    const body = await fs.readFile(path.join(runDir, 'README.md'), 'utf8');
    assert.match(body, /NOT the source of truth/);
    assert.match(body, /tasks\.json/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('writeScratchReadme: idempotent — does not overwrite an existing README', async () => {
  const tmp = await mkScratchTmpDir();
  try {
    const runDir = path.join(tmp, 'wfrun_123_abc');
    await fs.mkdir(runDir, { recursive: true });
    const readmePath = path.join(runDir, 'README.md');
    await fs.writeFile(readmePath, 'user-customised', 'utf8');
    await writeScratchReadme(runDir);
    const body = await fs.readFile(readmePath, 'utf8');
    assert.equal(body, 'user-customised');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Regression: pruning is gated on this "first materialization" signal rather
// than `stepIndex === 0`, so a start-first workflow (whose first agent step
// spawns at stepIndex >= 1) still prunes exactly once. The first spawn into a
// fresh run dir must return true; every later step must return false.
test('writeScratchReadme: returns true only on first materialization', async () => {
  const tmp = await mkScratchTmpDir();
  try {
    const runDir = path.join(tmp, 'wfrun_first_abc');
    await fs.mkdir(runDir, { recursive: true });
    // First step into a fresh run dir — should signal "prune now".
    assert.equal(await writeScratchReadme(runDir), true);
    // Later steps reuse the same run dir — must not re-signal.
    assert.equal(await writeScratchReadme(runDir), false);
    assert.equal(await writeScratchReadme(runDir), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Models the start-first workflow: step 0 (control) never materializes the
// run dir, so the FIRST spawnWorkflowStep call is at stepIndex >= 1. Pruning
// must still run once on that first materialization. Drive several runs and
// assert workflow-steps/ stays capped at WORKFLOW_RUN_RETENTION (5).
test('prune gating: start-first runs stay capped at retention', async () => {
  const tmp = await mkScratchTmpDir();
  try {
    const baseTime = Date.now() - 1_000_000;
    // Simulate 8 sequential runs, each first materializing at a non-zero step.
    for (let run = 0; run < 8; run++) {
      const runId = `wfrun_${run}_xxxx`;
      const runDir = path.join(tmp, runId);
      // step 1 is the first agent step (step 0 was a control step): mkdir +
      // README, and prune iff this is the run dir's first materialization.
      await fs.mkdir(path.join(runDir, 'step-1'), { recursive: true });
      const fresh = await writeScratchReadme(runDir);
      assert.equal(fresh, true, `run ${run} first step must materialize the run dir`);
      // Stamp a deterministic, increasing mtime AFTER the README write (which
      // would otherwise bump it to "now") so the newest run sorts last.
      const t = new Date(baseTime + run * 1_000);
      await fs.utimes(runDir, t, t);
      await pruneOldWorkflowRuns(tmp, runId);
      // A later step in the same run must NOT re-prune.
      assert.equal(await writeScratchReadme(runDir), false);
    }
    const remaining = (await fs.readdir(tmp)).filter((n) => n.startsWith('wfrun_'));
    assert.ok(
      remaining.length <= 5,
      `workflow-steps must stay capped at retention, found ${remaining.length}: ${remaining.join(', ')}`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pruneOldWorkflowRuns: keeps newest 5 + always keeps the active run', async () => {
  const tmp = await mkScratchTmpDir();
  try {
    // 7 old wfrun dirs with increasing mtimes
    const baseTime = Date.now() - 1_000_000;
    const dirs: string[] = [];
    for (let i = 0; i < 7; i++) {
      dirs.push(await touchDir(tmp, `wfrun_${i}_xxxx`, baseTime + i * 1_000));
    }
    // Plus the "active" run — give it the oldest mtime to prove it's still kept
    const active = await touchDir(tmp, 'wfrun_active_zzzz', baseTime - 50_000);

    await pruneOldWorkflowRuns(tmp, 'wfrun_active_zzzz');

    // Newest 5 (wfrun_2..wfrun_6) plus the active one survive; wfrun_0 + wfrun_1 are gone.
    for (let i = 0; i < 7; i++) {
      const exists = await fs
        .access(dirs[i])
        .then(() => true)
        .catch(() => false);
      assert.equal(exists, i >= 2, `wfrun_${i} survival mismatch (expected ${i >= 2})`);
    }
    const activeExists = await fs
      .access(active)
      .then(() => true)
      .catch(() => false);
    assert.ok(activeExists, 'active run dir must be preserved even with oldest mtime');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

function registerRunningRun(id: string, projectPath: string): WorkflowRun {
  const run: WorkflowRun = {
    id,
    workflowId: 'wf_test',
    workflowName: 'test',
    projectPath: canonicalProjectPath(projectPath),
    status: 'running',
    startedAt: 0,
    totalSteps: 3,
    currentStepIndex: 1,
  };
  runs.set(id, run);
  return run;
}

// Regression for the concurrent-run prune bug: pruneOldWorkflowRuns keeps the
// newest N by mtime and deletes the rest. Concurrent workflow runs are allowed,
// and a run parked on a long agent step keeps a stale run-dir mtime — so a burst
// of newer runs could push a still-active run past the retention window and
// delete its step scratch (Stop-hook completion config + create-task helper) out
// from under the backend, hanging it. The prune must exclude EVERY `running` run
// (from the state map), not just the one it is spawning into.
test('pruneOldWorkflowRuns: never deletes a still-running run, even the oldest', async () => {
  const tmp = await mkScratchTmpDir();
  const project = path.join(tmp, 'project');
  const registeredIds: string[] = [];
  try {
    const baseTime = Date.now() - 1_000_000;
    // 8 wfrun dirs, oldest → newest. Retention is 5, so the 3 OLDEST
    // (wfrun_0/1/2) are the deletion window.
    const dirs: string[] = [];
    for (let i = 0; i < 8; i++) {
      dirs.push(await touchDir(tmp, `wfrun_${i}_xxxx`, baseTime + i * 1_000));
    }

    // Register two of the three deletion-window dirs as `running`: the OLDEST
    // (wfrun_0 — would sort first for deletion) and a sibling (wfrun_2). Only
    // wfrun_1 in that window is not running.
    registeredIds.push('wfrun_0_xxxx', 'wfrun_2_xxxx');
    registerRunningRun('wfrun_0_xxxx', project);
    registerRunningRun('wfrun_2_xxxx', project);

    // Spawn context is a THIRD, newest run — so keepRunId does NOT cover the two
    // parked runs; only the active-set guard can save them.
    await pruneOldWorkflowRuns(
      tmp,
      'wfrun_7_xxxx',
      getRunningRunIds(project),
    );

    const survives = async (dir: string) =>
      fs.access(dir).then(() => true).catch(() => false);

    // Both running dirs survive despite being in the mtime deletion window.
    assert.ok(await survives(dirs[0]), 'running wfrun_0 (oldest) must survive');
    assert.ok(await survives(dirs[2]), 'running wfrun_2 must survive');
    // The one non-running dir in the deletion window is actually pruned, so the
    // guard didn't just disable pruning wholesale.
    assert.ok(!(await survives(dirs[1])), 'non-running wfrun_1 must be pruned');
    // Everything in the newest-5 window is untouched.
    for (let i = 3; i < 8; i++) {
      assert.ok(await survives(dirs[i]), `newest-window wfrun_${i} must survive`);
    }
  } finally {
    for (const id of registeredIds) runs.delete(id);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pruneOldWorkflowRuns: leaves non-wfrun dirs alone', async () => {
  const tmp = await mkScratchTmpDir();
  try {
    const baseTime = Date.now() - 1_000_000;
    // 7 wfrun dirs so prune actually has something to do
    for (let i = 0; i < 7; i++) {
      await touchDir(tmp, `wfrun_${i}_xxxx`, baseTime + i * 1_000);
    }
    const notWfrun = await touchDir(tmp, 'something-else', baseTime);
    await pruneOldWorkflowRuns(tmp, 'wfrun_6_xxxx');
    const exists = await fs
      .access(notWfrun)
      .then(() => true)
      .catch(() => false);
    assert.ok(exists, 'non-wfrun_* directory must be left alone');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pruneOldWorkflowRuns: no-op when nothing to prune', async () => {
  const tmp = await mkScratchTmpDir();
  try {
    const baseTime = Date.now();
    const dirs: string[] = [];
    for (let i = 0; i < 3; i++) {
      dirs.push(await touchDir(tmp, `wfrun_${i}_xxxx`, baseTime + i * 1_000));
    }
    await pruneOldWorkflowRuns(tmp, 'wfrun_2_xxxx');
    for (const d of dirs) {
      const exists = await fs
        .access(d)
        .then(() => true)
        .catch(() => false);
      assert.ok(exists, `${d} should survive when under retention threshold`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pruneOldWorkflowRuns: missing root is a no-op (does not throw)', async () => {
  const missing = path.join(os.tmpdir(), `lattice-prune-missing-${Date.now()}`);
  await pruneOldWorkflowRuns(missing, 'wfrun_anything');
  // success = no throw
  assert.ok(true);
});
