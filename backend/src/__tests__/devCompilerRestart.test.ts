import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCompilerLifecycle } from '../../scripts/dev/compilerLifecycle.mjs';
import type { TscWatchChild, TscWatchOptions } from '../../scripts/dev/tscWatch.mjs';

// After a dependency install the dev runner restarts `tsc -w` so it re-resolves
// node_modules (an already-running watcher that failed "Cannot find module"
// may never notice the package arriving). The deliberate restart must not be
// counted as a crash, must not spend the retry budget, and must fence backend
// restarts until the fresh compiler completes.

function fixture(retryDelays = [1000, 2000]) {
  const children: Array<TscWatchChild & { kills: number }> = [];
  const options: TscWatchOptions[] = [];
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  const records: Array<{ code: number; expected: boolean }> = [];
  let timer = 0;
  const lifecycle = createCompilerLifecycle({
    tscBin: 'compiler-fixture',
    startWatch: (_bin, opts = {}) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 55500 + children.length,
        kills: 0,
        kill: () => { child.kills++; return true; },
        tscSettledPromise: Promise.resolve(null),
      }) as unknown as TscWatchChild & { kills: number };
      children.push(child);
      options.push(opts);
      return child;
    },
    retryDelays,
    schedule: (callback, delay) => {
      const id = ++timer;
      scheduled.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    unschedule: (id) => { scheduled.delete(id as unknown as number); },
    record: (_label, code, details) => { records.push({ code, expected: details.expected }); },
  });
  return { lifecycle, children, options, scheduled, records };
}

test('restart() replaces a running compiler at once and fences backend restarts until it compiles', () => {
  const f = fixture();
  f.lifecycle.start();
  f.options[0].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(f.lifecycle.canRestartBackend(), true);

  assert.equal(f.lifecycle.restart('deps changed'), true);
  assert.equal(f.children[0].kills, 1);
  assert.equal(f.lifecycle.canRestartBackend(), false);
  f.children[0].emit('exit', 1, null);
  // Relaunched immediately — no retry timer, no polling fallback.
  assert.equal(f.children.length, 2);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.options[1].polling, false);
  assert.deepEqual(f.records, [{ code: 1, expected: true }]);
  assert.equal(f.lifecycle.canRestartBackend(), false);
  f.options[1].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(f.lifecycle.canRestartBackend(), true);
});

test('an ordinary crash after a deliberate restart is still a crash', () => {
  const f = fixture();
  f.lifecycle.start();
  f.lifecycle.restart('deps changed');
  f.children[0].emit('exit', 1, null);
  f.children[1].emit('exit', 3221225477, null);
  assert.equal(f.records[1].expected, false);
  assert.equal(f.scheduled.size, 1); // normal backoff repair
});

test('restart() resumes a compiler paused after exhausting its retries, with a fresh budget', () => {
  const f = fixture([1000]);
  f.lifecycle.start();
  f.children[0].emit('exit', 1, null);
  const [[id, item]] = [...f.scheduled];
  f.scheduled.delete(id);
  item.callback();
  f.children[1].emit('exit', 1, null);
  assert.equal(f.scheduled.size, 0); // paused
  assert.equal(f.children.length, 2);

  assert.equal(f.lifecycle.restart('deps changed'), true);
  assert.equal(f.children.length, 3);
  f.children[2].emit('exit', 1, null);
  assert.equal(f.scheduled.size, 1); // budget replenished → a retry is scheduled again
});

test('restart() cancels a pending repair timer and launches now; refused once stopped', () => {
  const f = fixture();
  f.lifecycle.start();
  f.children[0].emit('exit', 1, null);
  assert.equal(f.scheduled.size, 1);
  assert.equal(f.lifecycle.restart('deps changed'), true);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.children.length, 2);
  f.lifecycle.stop();
  assert.equal(f.lifecycle.restart('deps changed'), false);
});
