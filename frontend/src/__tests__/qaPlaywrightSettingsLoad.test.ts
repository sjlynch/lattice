import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { APP_CONFIG } from '../appConfig.ts';
import { useQaPlaywright } from '../components/taskboard/hooks/useQaPlaywright.ts';
import { usePostMergeHook } from '../components/taskboard/hooks/usePostMergeHook.ts';
import {
  installFakeWebSocket,
  installGlobal,
  installManualTimers,
  installWindow,
  type ManualTimers,
} from './domDoubles.ts';

// Regressions for the QA-lane Playwright toggles and the post-merge hook row:
// both loaded their settings with the lenient GET, which maps any failure (a
// 502 while the backend restarts — routine in dev) to `{}`, and never retried.
//  - the Globe/eye showed off/headless over a saved `{enabled: true, headless:
//    false}`, and the next Globe click PATCHed `{enabled: true, headless:
//    true}` — silently flipping the saved headed mode;
//  - the hook row read "Off" with an empty prompt while the backend still
//    fired the saved hook after every merge.
// A failed load now keeps the controls disabled (no PATCH) and retries.

let patches: Array<{ url: string; body: Record<string, unknown> }>;
// How a PATCH answers; defaults to 200. Swapped per test to fail or hang.
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
let patchResponse: () => Promise<FakeResponse>;
const patchOk = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
const patchFails = () =>
  Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
let errors: string[];
const recordError = (msg: string) => errors.push(msg);
let settingsFor: (url: string) => { ok: boolean; status: number; body: unknown };
let timers: ManualTimers;
let restores: Array<() => void>;

beforeEach(() => {
  patches = [];
  patchResponse = patchOk;
  errors = [];
  timers = installManualTimers();
  // The retry's first-failure warning is expected noise here.
  const warn = console.warn;
  console.warn = () => {};
  restores = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installWindow({ location: { protocol: 'http:', host: 'localhost:5184' } }),
    installFakeWebSocket(),
    installGlobal('fetch', ((url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        patches.push({ url, body: JSON.parse(init.body ?? '{}') });
        return patchResponse();
      }
      if (url.includes('/api/post-merge-hooks/active')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ active: null, recent: null }),
        });
      }
      const r = settingsFor(url);
      return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
    }) as unknown as typeof fetch),
    () => {
      console.warn = warn;
    },
  ];
});

afterEach(() => {
  for (const restore of restores.reverse()) restore();
  timers.restore();
});

// retryDelay(0): the first retry after a failed load.
const FIRST_RETRY_MS = APP_CONFIG.scanRetry.initialDelayMs;
const retryPending = () => timers.scheduled.some((t) => t.delay === FIRST_RETRY_MS);

const failing = () => ({ ok: false, status: 502, body: { error: 'bad gateway' } });

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

let qa!: ReturnType<typeof useQaPlaywright>;
function QaHarness({ folder }: { folder: string }) {
  qa = useQaPlaywright(folder, recordError);
  return null;
}

async function mountQa(folder: string) {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(QaHarness, { folder }));
  });
  await flush();
  return renderer;
}

test('a failed QA Playwright load keeps the toggles inert — no PATCH over the saved value', async () => {
  settingsFor = failing;
  const renderer = await mountQa('C:/project-A');

  assert.equal(qa.loaded, false);
  act(() => qa.onToggleEnabled());
  act(() => qa.onToggleHeadless());
  assert.equal(patches.length, 0, 'nothing is written over a value that never loaded');
  assert.equal(qa.enabled, false, 'the no-op toggle does not flip the local view either');
  assert.ok(retryPending(), 'the failed load schedules a retry');
  act(() => renderer.unmount());
  assert.ok(!retryPending(), 'unmount cancels the pending retry');
});

test('a toggle before the initial fetch resolves is a no-op', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((r) => (resolve = r));
  settingsFor = () => ({ ok: true, status: 200, body: { qaPlaywright: { enabled: true, headless: false } } });
  const realFetch = globalThis.fetch;
  restores.push(
    installGlobal('fetch', (async (url: string, init?: { method?: string }) => {
      if (init?.method !== 'PATCH') await pending;
      return realFetch(url, init as RequestInit);
    }) as unknown as typeof fetch),
  );
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(QaHarness, { folder: 'C:/project-A' }));
  });
  act(() => qa.onToggleEnabled());
  assert.equal(patches.length, 0);

  resolve();
  await flush();
  assert.equal(qa.loaded, true);
  assert.deepEqual({ enabled: qa.enabled, headless: qa.headless }, { enabled: true, headless: false });
  act(() => renderer.unmount());
});

test('the load retries after a failure, and toggling preserves the saved headless: false', async () => {
  let calls = 0;
  settingsFor = () =>
    ++calls === 1
      ? failing()
      : { ok: true, status: 200, body: { qaPlaywright: { enabled: true, headless: false } } };
  const renderer = await mountQa('C:/project-A');
  assert.equal(qa.loaded, false);

  await act(async () => timers.fireAll());
  await flush();
  assert.equal(qa.loaded, true, 'the retry loaded the saved value');
  assert.deepEqual({ enabled: qa.enabled, headless: qa.headless }, { enabled: true, headless: false });

  act(() => qa.onToggleEnabled());
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, { qaPlaywright: { enabled: false, headless: false } });
  act(() => qa.onToggleEnabled());
  assert.deepEqual(patches[1].body, { qaPlaywright: { enabled: true, headless: false } });
  act(() => renderer.unmount());
});

test('a failed QA toggle PATCH reverts the toggle to the saved value and shows an error', async () => {
  settingsFor = () => ({ ok: true, status: 200, body: { qaPlaywright: { enabled: false, headless: false } } });
  const renderer = await mountQa('C:/project-A');
  assert.equal(qa.loaded, true);

  patchResponse = patchFails;
  act(() => qa.onToggleEnabled());
  assert.equal(qa.enabled, true, 'optimistic: shown at once');
  await flush();
  assert.deepEqual(patches[0].body, { qaPlaywright: { enabled: true, headless: false } });
  assert.deepEqual(
    { enabled: qa.enabled, headless: qa.headless },
    { enabled: false, headless: false },
    'reverted to what the backend still holds',
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /QA Playwright toggle failed: boom/);

  // The next toggle builds on the reverted value, not the failed one.
  patchResponse = patchOk;
  act(() => qa.onToggleEnabled());
  await flush();
  assert.deepEqual(patches[1].body, { qaPlaywright: { enabled: true, headless: false } });
  assert.equal(qa.enabled, true);
  act(() => renderer.unmount());
});

test("a project switch drops the previous project's loaded QA toggle", async () => {
  settingsFor = (url) =>
    url.includes('project-A')
      ? { ok: true, status: 200, body: { qaPlaywright: { enabled: true, headless: false } } }
      : failing();
  const renderer = await mountQa('C:/project-A');
  assert.equal(qa.enabled, true);

  await act(async () => {
    renderer.update(React.createElement(QaHarness, { folder: 'C:/project-B' }));
  });
  await flush();
  assert.equal(qa.loaded, false);
  assert.equal(qa.enabled, false);
  act(() => qa.onToggleHeadless());
  assert.equal(patches.length, 0, "project A's value is never patched onto B");
  act(() => renderer.unmount());
});

let hook!: ReturnType<typeof usePostMergeHook>;
const noopAddTerminal = () => '';
function HookHarness({ folder }: { folder: string }) {
  hook = usePostMergeHook(folder, noopAddTerminal, recordError);
  return null;
}

test('a failed post-merge hook load keeps the form unloaded and every save inert, then retries', async () => {
  let calls = 0;
  settingsFor = () =>
    ++calls === 1
      ? failing()
      : {
          ok: true,
          status: 200,
          body: { postMergeHookPrompt: 'run the tests', postMergeHookEnabled: true },
        };
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(HookHarness, { folder: 'C:/project-A' }));
  });
  await flush();

  assert.equal(hook.loaded, false);
  act(() => hook.saveEnabled(false));
  act(() => hook.savePrompt(''));
  act(() => hook.saveHarness('codex'));
  assert.equal(patches.length, 0, 'no save writes over a hook form that never loaded');

  await act(async () => timers.fireAll());
  await flush();
  assert.equal(hook.loaded, true);
  assert.equal(hook.form.prompt, 'run the tests');
  assert.equal(hook.form.enabled, true);

  act(() => hook.saveEnabled(false));
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, { postMergeHookEnabled: false });
  act(() => renderer.unmount());
});

async function mountHook(folder: string) {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(HookHarness, { folder }));
  });
  await flush();
  return renderer;
}

test('a failed post-merge enable PATCH reverts the switch and shows an error', async () => {
  settingsFor = () => ({
    ok: true,
    status: 200,
    body: { postMergeHookPrompt: 'run the tests', postMergeHookEnabled: true },
  });
  const renderer = await mountHook('C:/project-A');
  assert.equal(hook.form.enabled, true);

  patchResponse = patchFails;
  act(() => hook.saveEnabled(false));
  assert.equal(hook.form.enabled, false, 'optimistic: shown at once');
  await flush();
  assert.equal(hook.form.enabled, true, 'the hook still fires, so the row reads On again');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Saving hook toggle failed: boom/);
  assert.equal(hook.saving, false);
  act(() => renderer.unmount());
});

test('a failed post-merge harness PATCH reverts the harness and Pi model', async () => {
  settingsFor = () => ({
    ok: true,
    status: 200,
    body: { postMergeHookHarness: 'pi', postMergeHookPiModel: 'local/qwen' },
  });
  const renderer = await mountHook('C:/project-A');
  assert.equal(hook.form.harness, 'pi');

  patchResponse = patchFails;
  act(() => hook.saveHarness('codex'));
  await flush();
  assert.equal(hook.form.harness, 'pi');
  assert.equal(hook.form.piModel, 'local/qwen');
  assert.equal(errors.length, 1);
  act(() => renderer.unmount());
});

test('post-merge `saving` stays true until every in-flight save settles', async () => {
  settingsFor = () => ({ ok: true, status: 200, body: { postMergeHookPrompt: 'p' } });
  const renderer = await mountHook('C:/project-A');

  const pending: Array<(r: FakeResponse) => void> = [];
  patchResponse = () => new Promise((resolve) => pending.push(resolve));
  act(() => hook.saveEnabled(false));
  act(() => hook.savePrompt('q'));
  assert.equal(hook.saving, true);
  assert.equal(pending.length, 2);

  pending[0]({ ok: true, status: 200, json: () => Promise.resolve({}) });
  await flush();
  assert.equal(hook.saving, true, 'the first save to settle does not clear it');

  pending[1]({ ok: true, status: 200, json: () => Promise.resolve({}) });
  await flush();
  assert.equal(hook.saving, false);
  assert.equal(hook.form.enabled, false);
  assert.equal(hook.form.prompt, 'q');
  act(() => renderer.unmount());
});
