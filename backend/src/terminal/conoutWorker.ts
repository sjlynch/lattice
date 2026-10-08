// node-pty's per-pty conout Worker thread, and the leak we close by hand.
//
// With `useConptyDll: true` (createSession.ts) node-pty 1.1.0 starts one
// worker_threads Worker per pty to drain the console's output pipe
// (lib/windowsConoutConnection.js). That Worker owns a net server on its own
// named pipe which nothing ever closes, so the thread lives until someone calls
// `ConoutConnection.dispose()`. node-pty only does that from `kill()`, and only
// on a LATER `data` event (lib/windowsPtyAgent.js) — which in practice never
// arrives — and never on a natural exit (`_$onProcessExit` returns early in DLL
// mode). Measured on Node 24 / Windows 10: 20 ptys, exited or killed → 20 live
// Workers and +195 MB RSS 15 s later; with the dispose below → 0 Workers,
// +5 MB. Each leaked Worker is a whole V8 isolate (~10 MB, invisible to
// `heapUsed`), and the terminal-server hosts every agent run for days.
//
// `releaseConoutWorker` runs from the pty's onExit (sessionLifecycle.ts), which
// both exit paths reach; by then the output socket has closed, so there is
// nothing left to drain. Disposing twice is harmless (Worker.terminate on a
// dead Worker resolves). The tracked set backs the `terminal.conoutWorkers`
// memory gauge: it should equal `terminal.sessions`; more means a Worker
// outlived its pty again (e.g. a node-pty upgrade changed these internals).

import type { Worker } from 'node:worker_threads';
import type * as pty from 'node-pty';
import { registerMemGauge } from '../memDiag/gauges.js';

type ConoutConnection = { dispose?: () => void; _worker?: Worker };

function conoutConnection(term: pty.IPty): ConoutConnection | null {
  const agent = (term as unknown as { _agent?: { _conoutSocketWorker?: ConoutConnection } })
    ._agent;
  return agent?._conoutSocketWorker ?? null;
}

const liveWorkers = new Set<Worker>();
registerMemGauge('terminal.conoutWorkers', () => liveWorkers.size);

export function trackConoutWorker(term: pty.IPty): void {
  const worker = conoutConnection(term)?._worker;
  if (!worker || typeof worker.once !== 'function') return;
  liveWorkers.add(worker);
  worker.once('exit', () => liveWorkers.delete(worker));
}

export function releaseConoutWorker(term: pty.IPty): void {
  try {
    conoutConnection(term)?.dispose?.();
  } catch {
    /* best-effort: never let cleanup break the exit path */
  }
}
