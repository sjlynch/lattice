import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { TerminalLaunchSettings, UserSettings } from '../api';
import {
  useSettingsDrafts,
  type SettingsDrafts,
} from '../components/settings/useSettingsDrafts.ts';

const TERMINAL_SETTINGS: TerminalLaunchSettings = {
  terminalDefaultHarness: 'claude',
  terminalClaudeSkipPermissions: false,
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
