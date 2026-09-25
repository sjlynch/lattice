import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { StartupTerminal, TerminalLaunchSettings } from '../api';
import {
  saveSettings,
  type SaveSettingsParams,
  type TerminalLaunchTouched,
} from '../components/settings/saveSettings.ts';

// Regression: saving Settings before the project's userSettings loaded (a
// project switch, or a reload while the backend restarts) always wrote
// `startupTerminals` — seeded `[]` from the not-yet-loaded list — and the three
// terminal-launch fields, which still held the previous project's values or the
// defaults. An unrelated save (an MCP toggle) then wiped the project's startup
// commands. Those fields are now written only once loaded, or when edited.

const NONE_TOUCHED: TerminalLaunchTouched = {
  terminalDefaultHarness: false,
  terminalClaudeSkipPermissions: false,
  codexYolo: false,
};

const NULL_HANDLES: SaveSettingsParams['handles'] = {
  startupTerminals: null,
  envNotes: null,
  instructionTemplates: null,
  harnessSystemPrompts: null,
  metricsIgnoredExts: null,
  agents: null,
  pi: null,
  mcp: null,
  tools: null,
};

type Captured = { url: string; method: string; body: Record<string, unknown> };
let requests: Captured[];
let startupChanges: StartupTerminal[][];
let launchChanges: TerminalLaunchSettings[];

const g = globalThis as unknown as Record<string, unknown>;
let savedFetch: unknown;

beforeEach(() => {
  requests = [];
  startupChanges = [];
  launchChanges = [];
  savedFetch = g.fetch;
  g.fetch = (url: string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
});

afterEach(() => {
  if (savedFetch === undefined) delete g.fetch;
  else g.fetch = savedFetch;
});

function params(overrides: Partial<SaveSettingsParams>): SaveSettingsParams {
  return {
    activeFolder: 'C:/project-b',
    settingsLoaded: false,
    startupTerminals: [],
    drafts: {
      terminalDefaultHarness: 'codex',
      terminalClaudeSkipPermissions: false,
      codexYolo: false,
      terminalLaunchTouched: NONE_TOUCHED,
    },
    handles: NULL_HANDLES,
    onStartupTerminalsChange: (next) => startupChanges.push(next),
    onTerminalLaunchSettingsChange: (next) => launchChanges.push(next),
    onMetricsIgnoredExtsChange: () => {},
    ...overrides,
  };
}

function settingsPatch(): Record<string, unknown> {
  const patch = requests.find(
    (r) => r.method === 'PATCH' && r.url.startsWith('/api/settings'),
  );
  assert.ok(patch, 'a PATCH /api/settings was sent');
  return patch.body;
}

test('an unloaded, untouched save writes neither startupTerminals nor the launch fields', async () => {
  await saveSettings(params({}));

  const body = settingsPatch();
  assert.equal('startupTerminals' in body, false);
  assert.equal('terminalDefaultHarness' in body, false);
  assert.equal('terminalClaudeSkipPermissions' in body, false);
  assert.equal('codexYolo' in body, false);
  assert.deepEqual(startupChanges, [], 'parent startup list left alone');
  assert.deepEqual(launchChanges, [], 'parent launch settings left alone');
});

test('before load, only the edited launch field and a touched startup list are written', async () => {
  const edited: StartupTerminal[] = [
    { id: 'st_1', label: 'dev', command: 'npm run dev' },
  ];
  await saveSettings(
    params({
      drafts: {
        terminalDefaultHarness: 'codex',
        terminalClaudeSkipPermissions: false,
        codexYolo: false,
        terminalLaunchTouched: { ...NONE_TOUCHED, terminalDefaultHarness: true },
      },
      handles: {
        ...NULL_HANDLES,
        startupTerminals: {
          getCleanedTerminals: () => edited,
          isTouched: () => true,
        },
      },
    }),
  );

  const body = settingsPatch();
  assert.deepEqual(body.startupTerminals, edited);
  assert.equal(body.terminalDefaultHarness, 'codex');
  assert.equal('terminalClaudeSkipPermissions' in body, false);
  assert.equal('codexYolo' in body, false);
  assert.deepEqual(startupChanges, [edited]);
  assert.equal(launchChanges.length, 1);
});

test('once loaded, startupTerminals and all launch fields are written', async () => {
  await saveSettings(params({ settingsLoaded: true }));

  const body = settingsPatch();
  assert.deepEqual(body.startupTerminals, []);
  assert.equal(body.terminalDefaultHarness, 'codex');
  assert.equal(body.terminalClaudeSkipPermissions, false);
  assert.equal(body.codexYolo, false);
  assert.deepEqual(startupChanges, [[]]);
  assert.deepEqual(launchChanges, [
    {
      terminalDefaultHarness: 'codex',
      terminalClaudeSkipPermissions: false,
      codexYolo: false,
    },
  ]);
});
