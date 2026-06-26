import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeWebSocket } from './domDoubles.ts';
import {
  usePostMergeHook,
  type PostMergeHookFormState,
} from '../components/taskboard/hooks/usePostMergeHook.ts';

// Regression: the post-merge-hook form must reset on project switch. Before the
// fix the load effect only `setForm`-ed on fetch SUCCESS, so when project B's
// settings fetch REJECTED (network blip / busy backend) the `.catch` "kept
// defaults" that were actually project A's still-loaded prompt. A later
// savePrompt/saveHarness would then patch A's prompt onto project B. The fix
// resets to defaults synchronously at the top of the effect, before the fetch
// resolves — mirroring the sibling hydrate effect's active/recent reset.
//
// This drives the real hook headlessly (like useWorkflowRunsProjectScope): A
// loads successfully, then we switch to B whose settings fetch rejects, and
// assert the form is reset rather than carrying A's prompt.

const A_PROMPT = 'PROJECT A POST-MERGE PROMPT';

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

// fetchUserSettings rejects only when r.ok is true but r.json() throws (its
// internal try/catch doesn't cover the non-awaited `return r.json()`), so that
// is exactly how we simulate project B's transient failure.
function settingsResponse(project: string) {
  if (project.includes('project-A')) {
    return {
      ok: true,
      json: () =>
        Promise.resolve({
          postMergeHookPrompt: A_PROMPT,
          postMergeHookHarness: 'claude',
        }),
    };
  }
  // project-B: ok, but the body read fails → fetchUserSettings rejects.
  return {
    ok: true,
    json: () => Promise.reject(new Error('settings B unavailable')),
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    WebSocket: g.WebSocket,
    window: g.window,
    document: g.document,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.WebSocket = FakeWebSocket;
  g.window = {
    location: { protocol: 'http:', host: 'localhost:5184' },
    addEventListener() {},
    removeEventListener() {},
  };
  g.document = { addEventListener() {}, removeEventListener() {} };
  g.fetch = (url: string) => {
    if (url.includes('/api/post-merge-hooks/active')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ active: null, recent: null }),
      });
    }
    if (url.includes('/api/settings')) {
      const project = url.includes('project-A') ? 'project-A' : 'project-B';
      return Promise.resolve(settingsResponse(project));
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

let latestForm: PostMergeHookFormState = { prompt: '', enabled: true, harness: 'claude' };
function Harness({ folder }: { folder: string }) {
  const { form } = usePostMergeHook(
    folder,
    () => '',
    () => {},
  );
  latestForm = form;
  return null;
}

// Flush the chained fetch microtasks (fetch → r.json() → hook setState).
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

test("a project switch whose settings fetch rejects resets the form instead of keeping the previous project's prompt", async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  const tree = (folder: string) =>
    React.createElement(Harness, { folder });

  // Mount on project A — its settings load succeeds.
  await act(async () => {
    renderer = TestRenderer.create(tree('C:/project-A'));
  });
  await act(async () => {
    await flush();
  });
  assert.equal(
    latestForm.prompt,
    A_PROMPT,
    "project A's saved prompt should load into the form",
  );

  // Switch to project B, whose settings fetch rejects.
  await act(async () => {
    renderer.update(tree('C:/project-B'));
  });
  await act(async () => {
    await flush();
  });

  assert.equal(
    latestForm.prompt,
    '',
    "the form must reset to empty on switch — project A's prompt must not bleed into B",
  );
  assert.equal(
    latestForm.harness,
    'claude',
    'the harness resets to the default too',
  );
  assert.equal(
    latestForm.enabled,
    true,
    'the enabled toggle resets to its default (on) too',
  );

  act(() => renderer.unmount());
});
