import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forgetPushRun,
  getPushRun,
  markPushRunDone,
  recordPushRun,
  subscribePushRuns,
  type PushRunEvent,
} from '../pushRuns.js';

// ---------- forgetPushRun guard ----------
//
// Regression guard mirroring forgetQaRun's. The frontend push poller forgets a
// run (DELETE /api/push-runs/:id) when it sees it finished, and a *transient*
// GET /api/push-runs/:id hiccup is indistinguishable from "the run is gone". If
// that dropped a still-running run, the run's later Stop-hook `/done` would hit
// markPushRunDone -> runs.get(id) is undefined -> returns false and emits no
// 'done' event (stranding any 'done'-event waiter, e.g. the workflow Push
// control step). So forget must refuse to drop a `running` run and only finalize
// a `done` one.

function makeRunningRun(id: string) {
  recordPushRun({
    id,
    projectPath: 'C:/dev/proj',
    cwd: `C:/dev/proj/.scratch/${id}`,
    status: 'running',
    createdAt: 1,
  });
}

test('forgetPushRun: keeps a still-running run (transient-failure DELETE must not drop it)', () => {
  const id = 'push_test_running_keep';
  makeRunningRun(id);
  forgetPushRun(id);
  assert.ok(getPushRun(id), 'a running run must survive forgetPushRun');

  // ...and its later Stop-hook /done still finds it, so the 'done' event fires.
  let doneFired = false;
  const unsubscribe = subscribePushRuns((e: PushRunEvent) => {
    if (e.type === 'done' && e.run.id === id) doneFired = true;
  });
  assert.equal(markPushRunDone(id), true, 'a surviving run can still be marked done');
  assert.equal(doneFired, true, "markPushRunDone emits the 'done' event");
  unsubscribe();

  // Tidy up the module-global registry: only a done run can be forgotten.
  forgetPushRun(id);
  assert.equal(getPushRun(id), undefined);
});

test('forgetPushRun: drops a run once it is marked done', () => {
  const id = 'push_test_done_drop';
  makeRunningRun(id);
  markPushRunDone(id);

  let forgottenFired = false;
  const unsubscribe = subscribePushRuns((e: PushRunEvent) => {
    if (e.type === 'forgotten' && e.id === id) forgottenFired = true;
  });
  forgetPushRun(id);
  unsubscribe();

  assert.equal(getPushRun(id), undefined, 'a done run is forgotten normally');
  assert.equal(forgottenFired, true, "forgetting a done run emits 'forgotten'");
});

test('forgetPushRun: an unknown id is a harmless no-op', () => {
  let anyEvent = false;
  const unsubscribe = subscribePushRuns(() => { anyEvent = true; });
  forgetPushRun('push_test_never_recorded');
  unsubscribe();
  assert.equal(anyEvent, false, 'forgetting an unknown id emits nothing');
});
