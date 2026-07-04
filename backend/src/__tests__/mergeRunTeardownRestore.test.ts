import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runTeardown } from '../mergeRuns/teardown.js';
import type { SnapshotHandle } from '../worktree.js';
import type { MergeRun } from '../mergeRuns/state.js';

function makeRun(over: Partial<MergeRun> = {}): MergeRun {
  return {
    id: 'run_test',
    projectPath: '/project',
    status: 'running',
    startedAt: 1,
    total: 0,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: [],
    cancelRequested: false,
    ...over,
  };
}

// BUG 2, part 1: a cancelled run must restore its snapshot in-session, NOT
// defer it to the next boot (which is where stale-snapshot clobbering happens).
test('runTeardown restores the snapshot on a cancelled run without a reboot', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-teardown-repo-'));
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-teardown-snap-'));
  try {
    // User's uncommitted change was captured, and the tree reset to HEAD.
    await fs.mkdir(path.join(snapshotDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(snapshotDir, 'src', 'work.ts'), 'user work', 'utf8');
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'work.ts'), 'HEAD version', 'utf8');

    const handle: SnapshotHandle = {
      dir: snapshotDir,
      modifiedTracked: ['src/work.ts'],
      untracked: [],
    };

    const restart = await runTeardown(
      projectPath,
      makeRun({ projectPath, cancelRequested: true }),
      handle,
      [],
      'acquire',
    );

    // The user's uncommitted work is back in the working tree immediately...
    assert.equal(
      await fs.readFile(path.join(projectPath, 'src', 'work.ts'), 'utf8'),
      'user work',
    );
    // ...the snapshot dir is gone (nothing left for boot recovery to re-apply)...
    await assert.rejects(fs.access(snapshotDir), { code: 'ENOENT' });
    // ...and a cancelled run never asks for an auto-restart.
    assert.equal(restart, false);
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
});
