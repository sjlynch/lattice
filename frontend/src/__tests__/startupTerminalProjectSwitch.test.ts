import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useUserSettings } from '../hooks/useUserSettings.ts';
import { useStartupTerminalSync } from '../hooks/useStartupTerminalSync.ts';
import type { UserSettings } from '../api';

// Regression: switching projects spawned the PREVIOUS project's startup
// terminals in the NEW project's directory (2026-08-26 — apply_digital's
// `npx next dev --turbopack -p 3005` turned up running inside interview_eci).
//
// The mechanism is pure React ordering. `useUserSettings` marked itself
// "loading" from an EFFECT, and effects run after the render that changed
// `activeFolder` — so for one commit consumers saw `loaded: true` paired with
// the old project's settings. `useStartupTerminalSync` then held that list
// (its own guard is `if (!loaded) return`, which keeps the previous value),
// and Sidebar's spawn effect keys on `activeFolder`, so it fired in exactly
// that commit with the NEW cwd and the OLD commands. Whether the pty actually
// appeared came down to which fetch resolved first, which is why it looked
// intermittent.
//
// Both hooks now stamp their state with the folder it came from and derive
// "is this mine?" during render, so a mismatched pairing can't be observed.

const A = 'C:/development/project-A';
const B = 'C:/development/project-B';

const A_SETTINGS: UserSettings = {
  startupTerminals: [
    { id: 'dev-server', label: 'Next dev (:3005)', command: 'npx next dev -p 3005' },
  ],
};
const B_SETTINGS: UserSettings = {
  startupTerminals: [{ id: 'stack', label: 'stack', command: 'npm run dev' }],
};

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

// Project B's settings fetch is held open so the switch commit happens while it
// is still in flight — the exact window the bug lived in.
let releaseB: () => void;
let bPending: Promise<void>;

// Every (folder, list) pairing a render observed, and every spawn the
// Sidebar-shaped consumer effect below would have performed.
let observed: Array<{ folder: string; commands: string[] }>;
let spawned: Array<{ cwd: string; command: string }>;

beforeEach(() => {
  observed = [];
  spawned = [];
  bPending = new Promise<void>((res) => {
    releaseB = res;
  });
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.fetch = (url: string) => {
    if (url.includes('project-A')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(A_SETTINGS) });
    }
    return bPending.then(() => ({
      ok: true,
      json: () => Promise.resolve(B_SETTINGS),
    }));
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

// Mirrors App: one shared userSettings fetch, the startup-terminal slice read
// off it — plus a stand-in for Sidebar's `useStartupTerminals` spawn effect,
// which is keyed on `activeFolder` and launches each command with cwd = the
// folder that is active right now.
function Harness({ folder }: { folder: string }) {
  const userSettings = useUserSettings(folder);
  const [startupTerminals] = useStartupTerminalSync(folder, userSettings);

  observed.push({ folder, commands: startupTerminals.map((t) => t.command) });

  useEffect(() => {
    for (const cfg of startupTerminals) {
      spawned.push({ cwd: folder, command: cfg.command });
    }
  }, [folder, startupTerminals]);

  return null;
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("switching projects never spawns the previous project's startup terminals in the new one", async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  const tree = (folder: string) => React.createElement(Harness, { folder });

  await act(async () => {
    renderer = TestRenderer.create(tree(A));
  });
  await act(async () => {
    await flush();
  });
  assert.deepEqual(
    spawned,
    [{ cwd: A, command: 'npx next dev -p 3005' }],
    "project A's own startup terminal should launch in project A",
  );

  // Switch to B while B's settings fetch is still in flight.
  await act(async () => {
    renderer.update(tree(B));
  });
  await act(async () => {
    await flush();
  });

  const leaked = spawned.filter((s) => s.cwd === B && s.command.includes('next dev'));
  assert.deepEqual(
    leaked,
    [],
    "project A's dev server must not be spawned in project B",
  );

  // Now let B's settings land; its OWN startup terminal should launch.
  await act(async () => {
    releaseB();
    await flush();
  });
  assert.deepEqual(
    spawned.filter((s) => s.cwd === B),
    [{ cwd: B, command: 'npm run dev' }],
    "project B should end up running exactly its own startup terminal",
  );

  // The stronger invariant: no render ever paired a folder with another
  // project's commands, in flight or settled.
  const commandsFor: Record<string, string[]> = {
    [A]: ['npx next dev -p 3005'],
    [B]: ['npm run dev'],
  };
  for (const row of observed) {
    for (const command of row.commands) {
      assert.ok(
        commandsFor[row.folder].includes(command),
        `render paired ${row.folder} with a foreign command: ${command}`,
      );
    }
  }

  act(() => renderer.unmount());
});

test("an empty active folder clears the list rather than keeping the last project's", async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  const tree = (folder: string) => React.createElement(Harness, { folder });

  await act(async () => {
    renderer = TestRenderer.create(tree(A));
  });
  await act(async () => {
    await flush();
  });

  await act(async () => {
    renderer.update(tree(''));
  });
  await act(async () => {
    await flush();
  });

  assert.deepEqual(
    observed.at(-1),
    { folder: '', commands: [] },
    'clearing the project must clear the startup-terminal list',
  );

  act(() => renderer.unmount());
});
