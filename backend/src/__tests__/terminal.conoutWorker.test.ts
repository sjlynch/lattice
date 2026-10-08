// node-pty 1.1.0 (`useConptyDll: true`) starts one conout Worker thread per pty
// and never stops it on exit or kill (~10 MB of executor RSS each, invisible to
// heapUsed): measured 20 ended ptys → 20 live Workers, +195 MB. The executor
// disposes it from the pty's onExit (terminal/conoutWorker.ts). These pin the
// release/tracking contract against a fake pty, and fail loudly if a node-pty
// upgrade renames the private fields the release reaches into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as pty from 'node-pty';
import { releaseConoutWorker, trackConoutWorker } from '../terminal/conoutWorker.js';
import { readMemGauges } from '../memDiag/gauges.js';

function fakePty() {
  const worker = new EventEmitter();
  let disposed = 0;
  const term = {
    _agent: { _conoutSocketWorker: { _worker: worker, dispose: () => { disposed += 1; } } },
  } as unknown as pty.IPty;
  return { term, worker, disposed: () => disposed };
}

test('tracks the conout Worker until it exits, and release disposes it', () => {
  const before = readMemGauges()['terminal.conoutWorkers'];
  const a = fakePty();
  trackConoutWorker(a.term);
  assert.equal(readMemGauges()['terminal.conoutWorkers'], before + 1);
  releaseConoutWorker(a.term);
  assert.equal(a.disposed(), 1);
  a.worker.emit('exit', 1);
  assert.equal(readMemGauges()['terminal.conoutWorkers'], before);
});

test('a pty without the private fields (winpty / other platforms) is a no-op', () => {
  const term = {} as unknown as pty.IPty;
  assert.doesNotThrow(() => {
    trackConoutWorker(term);
    releaseConoutWorker(term);
  });
});

test('node-pty still has the internals releaseConoutWorker relies on', () => {
  const require = createRequire(import.meta.url);
  const lib = path.dirname(require.resolve('node-pty/lib/windowsPtyAgent.js'));
  const agent = fs.readFileSync(path.join(lib, 'windowsPtyAgent.js'), 'utf8');
  const conout = fs.readFileSync(path.join(lib, 'windowsConoutConnection.js'), 'utf8');
  assert.match(agent, /this\._conoutSocketWorker\s*=/, 'WindowsPtyAgent._conoutSocketWorker');
  assert.match(conout, /this\._worker\s*=\s*new worker_threads_1\.Worker/, 'ConoutConnection._worker');
  assert.match(conout, /ConoutConnection\.prototype\.dispose\s*=/, 'ConoutConnection.dispose');
});
