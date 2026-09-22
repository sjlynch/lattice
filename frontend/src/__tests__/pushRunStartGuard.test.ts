import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { usePushRun } from '../components/taskboard/hooks/usePushRun.ts';

// Regression for usePushRun.startPush:
//  1. `activePush` stays null for the whole POST /api/push-runs round-trip and
//     the Push button is disabled only off `activePush`, so a double-click
//     started TWO push sessions racing git in one repo (the backend does not
//     dedupe). An in-flight ref now drops the second click.
//  2. A start that resolves after a project switch used to be tracked as the
//     NEW project's push — disabling B's Push button for A's whole run.

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let pushPosts: Array<(value: unknown) => void>;

function okJson(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  pushPosts = [];
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    window: g.window,
    document: g.document,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  g.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  g.fetch = (url: string, init?: { method?: string }) => {
    if (url === '/api/push-runs' && init?.method === 'POST') {
      return new Promise((resolve) => pushPosts.push(resolve));
    }
    if (url.startsWith('/api/git-check')) return Promise.resolve(okJson({ hasGit: true }));
    // Status polls: keep the run "running".
    return Promise.resolve(okJson({ status: 'running' }));
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

type Hook = ReturnType<typeof usePushRun>;
let latest!: Hook;
let added: string[] = [];
function Harness({ folder }: { folder: string }) {
  latest = usePushRun(
    folder,
    (spec) => {
      added.push(spec.id ?? '');
      return spec.id ?? 'term';
    },
    () => {},
    () => {},
  );
  return null;
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const pushResult = {
  id: 'run-1',
  terminalId: 'term-1',
  cwd: 'C:/p',
  command: 'claude',
  serverId: 'srv-1',
};

test('a double-click on Push starts exactly one push run', async () => {
  added = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { folder: 'C:/project-A' }));
  });
  await act(async () => {
    void latest.startPush();
    void latest.startPush();
    await flush();
  });
  assert.equal(pushPosts.length, 1, 'the second click must not POST again');

  await act(async () => {
    pushPosts[0](okJson(pushResult));
    await flush();
  });
  assert.deepEqual(latest.activePush, { runId: 'run-1', terminalId: 'term-1' });
  act(() => renderer.unmount());
});

test('a push that resolves after a project switch is not tracked as the new project\'s push', async () => {
  added = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { folder: 'C:/project-A' }));
  });
  await act(async () => {
    void latest.startPush();
    await flush();
  });
  await act(async () => {
    renderer.update(React.createElement(Harness, { folder: 'C:/project-B' }));
  });
  await act(async () => {
    pushPosts[0](okJson(pushResult));
    await flush();
  });
  assert.equal(latest.activePush, null, "project B's Push button must stay enabled");
  assert.deepEqual(added, ['term-1'], "A's terminal is still mounted (project-scoped)");
  act(() => renderer.unmount());
});
