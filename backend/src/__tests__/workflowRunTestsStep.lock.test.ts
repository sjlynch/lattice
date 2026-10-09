// The Run tests step's project run lock: labelled per run and NOT lendable, so
// a resolver mutation (finalize/snapshot) waits for its release instead of
// running under the Run tests agent, and a merge is refused with wording that
// names the step. A workflow-test lock is exempt from the forced dev restart
// and never resumed as an interrupted merge run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTestsLockLabel } from '../workflowRuns/testStep/runTestsStep.js';
import {
  acquireProjectRunLock,
  inspectProjectRunLock,
  withProjectMutation,
  ProjectRunLockedError,
} from '../projectRunLock.js';
import { isResumableInterruptedRunLock } from '../recovery/mergeRunResume.js';
import { sleep } from './helpers/workflowRunTestsStep.js';

test('the Run tests lock is not lent: a resolver mutation waits for its release; a merge is refused naming the step', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-runtests-lock-'));
  try {
    const lock = await acquireProjectRunLock(project, runTestsLockLabel('wfrun_x'), { lendable: false });
    let mutated = false;
    const mutation = withProjectMutation(project, async () => { mutated = true; });
    await sleep(120);
    assert.equal(mutated, false, 'a finalize/snapshot must not run under the Run tests agent');

    await assert.rejects(acquireProjectRunLock(project, 'manual-merge'), (err: unknown) => {
      assert.ok(err instanceof ProjectRunLockedError);
      assert.match((err as Error).message, /Run tests step \(run wfrun_x\)/);
      return true;
    });

    await lock.release();
    await mutation;
    assert.equal(mutated, true, 'the deferred mutation runs once the step releases');
    assert.equal(await inspectProjectRunLock(project), null);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('workflow-test locks: exempt from the forced dev restart, never resumed as a merge run', async () => {
  const { isWorkflowLockLabel } = await import('../../scripts/dev/restartPolicy.mjs' as string) as { isWorkflowLockLabel: (l: string) => boolean };
  assert.equal(isWorkflowLockLabel(runTestsLockLabel('wfrun_1')), true);
  assert.equal(isResumableInterruptedRunLock(runTestsLockLabel('wfrun_1')), false);
});
