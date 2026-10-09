// Shared fixtures for the backendRestartResilience suites, split by behaviour
// across backendRestartResilience.{transport,vanishedRun,workflowStart,
// resume}.test.ts.
//
// Lattice restarts its own backend whenever it merges a backend change into
// itself. These suites pin the frontend half of surviving that: unaccepted
// start actions retry through the gap, lost acknowledgements never replay a
// resume or workflow start, a mid-recovery `hello` is not read as "the run
// vanished", the workflow queue asks before declaring a vanished run errored,
// and the navbar can tell that the live channels are down.
//
// Here: run / workflow builders for one project, the per-test browser globals
// (`installRestartGlobals`), and the failure shapes a restart produces —
// `ambiguousFailures` are the ones that may have reached the backend, which
// `lostAcknowledgement` turns into a fetch outcome.
import { beforeEach, afterEach } from 'node:test';
import React from 'react';
import type { Workflow, WorkflowRun } from '../api';
import { HttpError } from '../api/http.ts';
import { FakeWebSocket } from './domDoubles.ts';

export const FOLDER = 'C:/proj';

export function run(id: string, workflowId = 'wf1', over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowId,
    workflowName: `wf ${workflowId}`,
    projectPath: FOLDER,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: 1,
    currentStepIndex: 0,
    ...over,
  };
}

function workflow(id: string): Workflow {
  return { id, name: `wf ${id}`, projectPath: FOLDER, steps: [], variables: [], createdAt: 0 };
}

export const noSleep = () => Promise.resolve();

export const g = globalThis as unknown as Record<string, unknown>;

let savedGlobals: Record<string, unknown>;

// Call once at a suite's top level: before each test it installs the browser
// doubles the hooks under test need (FakeWebSocket with its instances reset, a
// window location, the act() environment, React for the classic-runtime
// provider JSX, an in-memory sessionStorage) and after each test it restores
// every global it saved — including a `fetch` the test replaced through `g`.
export function installRestartGlobals(): void {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    savedGlobals = {
      IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
      WebSocket: g.WebSocket,
      window: g.window,
      fetch: g.fetch,
      React: g.React,
      sessionStorage: g.sessionStorage,
    };
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.WebSocket = FakeWebSocket;
    g.window = { location: { protocol: 'http:', host: 'localhost:5183' } };
    // The provider JSX uses the classic runtime in these node:test fixtures.
    g.React = React;
    const storage = new Map<string, string>();
    g.sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });
}

export const workflows = new Map([['wf1', workflow('wf1')], ['wf2', workflow('wf2')]]);

export function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

export function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

export const ambiguousFailures = [
  new TypeError('Failed to fetch'),
  new HttpError(504, 'gateway timeout'),
  new HttpError(502, '[api-proxy]: ECONNRESET (socket hang up)'),
];

export function lostAcknowledgement(error: Error) {
  if (error instanceof HttpError) return jsonResponse(error.status, { error: error.message });
  throw error;
}
