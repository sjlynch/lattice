import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { TerminalLaunchSettings, UserSettings } from '../api';
import {
  pickSavableFetchedToggles,
  useSettingsDrafts,
  type SettingsDrafts,
} from '../components/settings/useSettingsDrafts.ts';

const TERMINAL_SETTINGS: TerminalLaunchSettings = {
  terminalDefaultHarness: 'claude',
  terminalClaudeSkipPermissions: false,
  codexYolo: true,
};

type FetchResponse = { ok: boolean; json: () => Promise<UserSettings> };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let latest: SettingsDrafts;
function Harness({ open, folder }: { open: boolean; folder: string }) {
  latest = useSettingsDrafts(open, folder, TERMINAL_SETTINGS);
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

let saved: Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

test('late settings fetch seeds baselines without overwriting touched parent drafts', async () => {
  const pendingSettings = deferred<FetchResponse>();
  g.fetch = () => pendingSettings.promise;

  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { open: true, folder: 'C:/project' }),
    );
  });

  // Toggle all three fetched parent-owned drafts before GET /api/settings settles.
  act(() => {
    latest.setInstrumentClaude(false);
    latest.setDisableMemory(false);
    latest.setQaTerminalAutoClose(true);
  });
  assert.equal(latest.instrumentClaude, false);
  assert.equal(latest.disableMemory, false);
  assert.equal(latest.qaTerminalAutoClose, true);
  assert.equal(latest.dirty, true);

  await act(async () => {
    pendingSettings.resolve({
      ok: true,
      json: async () => ({
        instrumentProjectClaudeSessions: true,
        disableClaudeMemory: true,
        qaTerminalAutoClose: false,
      }),
    });
  });
  await flush();

  assert.equal(latest.instrumentClaude, false, 'instrument toggle stays user-edited');
  assert.equal(latest.disableMemory, false, 'memory toggle stays user-edited');
  assert.equal(latest.qaTerminalAutoClose, true, 'QA auto-close stays user-edited');
  assert.equal(latest.dirty, true, 'drafts remain dirty against the fetched baseline');

  act(() => {
    renderer!.unmount();
  });
});

// Regression: a settings GET that FAILED (a 502 while the backend restarts)
// used to read as `{}` (lenient fetch) and every untouched fetched draft kept
// its hard-coded default — which Save then wrote over the project's saved
// values (a saved `qaTerminalAutoClose: true` / `restoreTerminalsOnOpen:
// 'never'` silently reset by saving any other tab). Save now writes only the
// fetched toggles that loaded or were edited.
test('a failed settings GET leaves untouched fetched toggles out of the save patch', async () => {
  g.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 502,
      json: async () => ({ error: 'bad gateway' }),
    });

  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { open: true, folder: 'C:/project' }),
    );
  });
  await flush();

  assert.deepEqual(
    latest.getSavableFetchedToggles(),
    {},
    'nothing loaded and nothing edited → nothing to write',
  );

  act(() => {
    latest.setQaTerminalAutoClose(true);
  });
  assert.deepEqual(
    latest.getSavableFetchedToggles(),
    { qaTerminalAutoClose: true },
    'an edited toggle is still saved',
  );

  act(() => {
    renderer!.unmount();
  });
});

test('a successful settings GET makes every fetched toggle savable', async () => {
  g.fetch = () =>
    Promise.resolve({
      ok: true,
      json: async () => ({ qaTerminalAutoClose: true, restoreTerminalsOnOpen: 'never' }),
    });

  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { open: true, folder: 'C:/project' }),
    );
  });
  await flush();

  assert.deepEqual(latest.getSavableFetchedToggles(), {
    instrumentClaude: true,
    disableMemory: true,
    qaTerminalAutoClose: true,
    restoreTerminalsOnOpen: 'never',
    restoreNudgeAgents: true,
    restoreNudgeUserTabs: false,
  });

  act(() => {
    renderer!.unmount();
  });
});

test('pickSavableFetchedToggles: loaded → all, unloaded → only touched', () => {
  const values = {
    instrumentClaude: false,
    disableMemory: true,
    qaTerminalAutoClose: false,
    restoreTerminalsOnOpen: 'always' as const,
    restoreNudgeAgents: true,
    restoreNudgeUserTabs: false,
  };
  const none = {
    instrumentClaude: false,
    disableMemory: false,
    qaTerminalAutoClose: false,
    restoreTerminalsOnOpen: false,
    restoreNudgeAgents: false,
    restoreNudgeUserTabs: false,
  };
  assert.deepEqual(pickSavableFetchedToggles(values, none, true), values);
  assert.deepEqual(pickSavableFetchedToggles(values, none, false), {});
  assert.deepEqual(
    pickSavableFetchedToggles(values, { ...none, instrumentClaude: true }, false),
    { instrumentClaude: false },
  );
});
