import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPushPoll,
  type PushPollResult,
} from '../components/taskboard/hooks/usePushRun.ts';

// applyPushPoll is the decision the push poller makes on every tick: tear the
// run down (close terminal + DELETE the run + clear local tracking) ONLY when
// it is genuinely finished. These tests lock the regression: a transient fetch
// failure must NOT be treated as "run gone".

type Calls = { close: number; forget: number; clear: number };

function spies() {
  const calls: Calls = { close: 0, forget: 0, clear: 0 };
  const actions = {
    closeTerminal: () => { calls.close++; },
    forgetRun: () => { calls.forget++; },
    clearActive: () => { calls.clear++; },
  };
  return { calls, actions };
}

function run(result: PushPollResult): Calls {
  const { calls, actions } = spies();
  applyPushPoll(result, actions);
  return calls;
}

// --- The regression: a transient poll failure is ignored --------------------

test("a transient fetch failure ('error') does NOT close the terminal or DELETE the run", () => {
  // Pre-fix, a thrown fetch was caught to `null` and fell through to teardown,
  // force-closing the push pty mid commit/push and forgetting a live run.
  assert.deepEqual(run('error'), { close: 0, forget: 0, clear: 0 });
});

// --- A live run is left alone ----------------------------------------------

test('a still-running run is left untouched', () => {
  assert.deepEqual(run({ status: 'running' }), { close: 0, forget: 0, clear: 0 });
});

// --- Genuine completion tears down ------------------------------------------

test("status === 'done' tears the run down", () => {
  assert.deepEqual(run({ status: 'done' }), { close: 1, forget: 1, clear: 1 });
});

test('a real 404 (null) tears the run down', () => {
  assert.deepEqual(run(null), { close: 1, forget: 1, clear: 1 });
});
