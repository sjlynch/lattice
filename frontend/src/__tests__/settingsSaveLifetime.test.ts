import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useEffect, useLayoutEffect, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  normalizeTerminalLaunchSettings,
  type PiProvider,
  type StartupTerminal,
  type TerminalLaunchSettings,
  type UserSettings,
} from '../api';
import { useUserSettings } from '../hooks/useUserSettings.ts';
import { useStartupTerminalSync } from '../hooks/useStartupTerminalSync.ts';
import { useMetricsIgnoredExts } from '../hooks/useMetricsIgnoredExts.ts';
import { ConfirmProvider } from '../components/shared/ConfirmDialog.tsx';
import { useSettingsController } from '../components/settings/useSettingsController.ts';
import { useSettingsDrafts, type SettingsDrafts } from '../components/settings/useSettingsDrafts.ts';
import { StartupTerminalsTab } from '../components/settings/StartupTerminalsTab.tsx';
import { MetricsIgnoredExtsTab } from '../components/settings/MetricsIgnoredExtsTab.tsx';
import { installGlobal } from './domDoubles.ts';

const A = 'C:/project-A';
const B = 'C:/project-B';
const DEFAULT_LAUNCH = normalizeTerminalLaunchSettings(null);
const A_SETTINGS: UserSettings = {
  terminalDefaultHarness: 'claude', terminalClaudeSkipPermissions: true, codexYolo: true,
  startupTerminals: [{ id: 'a', label: 'A', command: 'npm run a' }],
  metricsIgnoredExts: ['.a'],
};
const B_SETTINGS: UserSettings = {
  terminalDefaultHarness: 'codex', terminalClaudeSkipPermissions: false, codexYolo: false,
  startupTerminals: [{ id: 'b', label: 'B', command: 'npm run b' }],
  metricsIgnoredExts: ['.b'],
};
const PROVIDERS: PiProvider[] = [{
  id: 'local', baseUrl: 'http://localhost:8000/v1', models: [{ id: 'model' }],
}];
type JsonResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const json = (value: unknown): JsonResponse => ({ ok: true, status: 200, json: async () => value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
type Request = { url: string; method: string; body: Record<string, unknown> };
type Write = Request & { resolve: () => void; reject: (error: Error) => void };
let requests: Request[];
let writes: Write[];
let holdMetrics: boolean;
let settingsReads: Map<string, ReturnType<typeof deferred<JsonResponse>>>;
let published: Array<{ folder: string; kind: string }>;
let closes: number;
let restores: Array<() => void>;
let renderer: ReturnType<typeof TestRenderer.create> | undefined;
let latest!: {
  folder: string;
  loaded: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  launch: TerminalLaunchSettings;
  startup: StartupTerminal[];
  metrics: string[];
  drafts: SettingsDrafts;
  controller: ReturnType<typeof useSettingsController>;
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Mirrors App's launch-default state and uses the actual shared settings and
// slice hooks. The controller and editable tabs stay mounted across project
// switches just as they do in TopAppBar's floating Settings panel.
function Harness({ folder }: { folder: string }) {
  const [open, setOpen] = useState(true);
  const userSettings = useUserSettings(folder);
  const [startup, setStartup] = useStartupTerminalSync(folder, userSettings);
  const [metrics, saveMetrics] = useMetricsIgnoredExts(folder, userSettings);
  const [launch, setLaunch] = useState(DEFAULT_LAUNCH);
  useEffect(() => {
    setLaunch(folder && userSettings.loaded && userSettings.settings
      ? normalizeTerminalLaunchSettings(userSettings.settings) : DEFAULT_LAUNCH);
  }, [folder, userSettings.loaded, userSettings.settings]);
  const drafts = useSettingsDrafts(open, folder, launch);
  const controller = useSettingsController({
    open, activeFolder: folder, settingsLoaded: userSettings.loaded, drafts,
    startupTerminals: startup,
    onClose: () => { closes++; setOpen(false); },
    onStartupTerminalsChange: (next) => {
      published.push({ folder, kind: 'startup' });
      setStartup(next);
    },
    onTerminalLaunchSettingsChange: (next) => {
      published.push({ folder, kind: 'launch' });
      setLaunch(next);
    },
    onMetricsIgnoredExtsChange: (next) => {
      published.push({ folder, kind: 'metrics' });
      return saveMetrics(next);
    },
  });
  useLayoutEffect(() => {
    latest = { folder, loaded: userSettings.loaded, open, setOpen, launch, startup, metrics, drafts, controller };
  });
  return open ? React.createElement('section', { 'data-panel': 'settings' },
    React.createElement(StartupTerminalsTab, {
      ref: controller.refs.startupTerminals, active: !!folder, open, startupTerminals: startup,
    }),
    React.createElement(MetricsIgnoredExtsTab, {
      ref: controller.refs.metricsIgnoredExts, active: !!folder, open, metricsIgnoredExts: metrics,
    }),
  ) : null;
}
const tree = (folder: string) => React.createElement(ConfirmProvider, {
  children: React.createElement(Harness, { folder }),
});

beforeEach(() => {
  requests = [];
  writes = [];
  holdMetrics = false;
  published = [];
  closes = 0;
  settingsReads = new Map([[A, deferred<JsonResponse>()], [B, deferred<JsonResponse>()]]);
  restores = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('React', React),
    installGlobal('fetch', (url: string, init?: RequestInit) => {
      const request: Request = {
        url: String(url), method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : {},
      };
      requests.push(request);
      if (request.method === 'GET' && url.startsWith('/api/settings?')) {
        const folder = new URL(url, 'http://localhost').searchParams.get('project')!;
        assert.ok(settingsReads.has(folder), `unexpected settings GET for ${folder}`);
        return settingsReads.get(folder)!.promise;
      }
      if (request.method === 'PATCH') {
        // The metrics slice callback repeats only that field's persistence.
        // Complete it immediately; hold each controller save's main writes.
        if (!holdMetrics && url.startsWith('/api/settings?') && Object.keys(request.body).length === 1
          && 'metricsIgnoredExts' in request.body) return Promise.resolve(json(request.body));
        return new Promise<JsonResponse>((resolve, reject) => {
          writes.push({ ...request, resolve: () => resolve(json(request.body)), reject });
        });
      }
      if (url === '/api/pi-models') return Promise.resolve(json({ models: [], menu: [] }));
      assert.equal(url, '/api/project-instrumentation', `unexpected request ${url}`);
      return Promise.resolve(json({}));
    }),
  ];
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  restores.reverse().forEach((restore) => restore());
});

async function loadSettings(folder: string, settings: UserSettings) {
  await act(async () => { settingsReads.get(folder)!.resolve(json(settings)); await flush(); });
  assert.equal(latest.loaded, true);
}
async function mount(folder = A) {
  await act(async () => { renderer = TestRenderer.create(tree(folder)); await flush(); });
  if (folder) await loadSettings(folder, A_SETTINGS);
}
async function switchProject(folder: string, settings: UserSettings) {
  await act(async () => { renderer!.update(tree(folder)); await flush(); });
  assert.equal(latest.loaded, false, 'the new settings fetch is still pending');
  await loadSettings(folder, settings);
}
function editTabs(command: string, extension: string) {
  act(() => {
    renderer!.root.findByProps({ placeholder: 'command (e.g. npm run dev)' })
      .props.onChange({ target: { value: command } });
    renderer!.root.findByProps({ placeholder: '.json' })
      .props.onChange({ target: { value: extension } });
    latest.controller.bumpDirty();
  });
}
function editNewSession() {
  act(() => {
    latest.drafts.setTerminalDefaultHarness('pi');
    latest.drafts.setQaTerminalAutoClose(true);
  });
  editTabs('npm run new-draft', '.new-draft');
}
function snapshot() {
  return {
    launch: latest.launch, startup: latest.startup, metrics: latest.metrics,
    draftLaunch: {
      terminalDefaultHarness: latest.drafts.terminalDefaultHarness,
      terminalClaudeSkipPermissions: latest.drafts.terminalClaudeSkipPermissions,
      codexYolo: latest.drafts.codexYolo,
    },
    draftFetched: latest.drafts.getSavableFetchedToggles(),
    draftStartup: latest.controller.refs.startupTerminals.current?.getCleanedTerminals(),
    draftMetrics: latest.controller.refs.metricsIgnoredExts.current?.getMetricsIgnoredExtsPatch(),
    dirty: latest.controller.dirtyByTab,
  };
}
function assertEditorSurvives(expected: ReturnType<typeof snapshot>, saving = false, error: string | null = null) {
  assert.equal(latest.open, true, 'the current panel stays open');
  assert.equal(closes, 0, 'the old save must not close the current panel');
  assert.deepEqual(published, [], 'the old save must not publish any parent callback');
  assert.deepEqual(snapshot(), expected, 'launch defaults, metrics, startup list and drafts survive');
  assert.equal(latest.controller.saving, saving, 'only the current session owns its busy state');
  assert.equal(latest.controller.error, error, 'only the current session owns its error');
}
async function startSave(withPi = false) {
  let done!: Promise<void>;
  await act(async () => {
    if (withPi) latest.controller.refs.pi.current = {
      getPiProvidersPatch: () => PROVIDERS, getPiModelMenuPatch: () => undefined,
    };
    done = latest.controller.save();
    // The save holds the captured handle even after a later editor replaces it.
    latest.controller.refs.pi.current = null;
    await flush();
  });
  assert.equal(latest.controller.saving, true);
  return { done, write: writes.at(-1)! };
}
async function settle(write: Write, outcome: 'success' | 'failure', done: Promise<void>, message = 'old save failed') {
  await act(async () => {
    if (outcome === 'success') write.resolve();
    else write.reject(new Error(message));
    await done;
    await flush();
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`late project-save ${outcome} preserves B's loaded settings and edited panel`, async () => {
    await mount();
    editTabs('npm run a-saved', '.a-saved');
    const old = await startSave();
    assert.equal(new URL(old.write.url, 'http://localhost').searchParams.get('project'), A);
    assert.equal(old.write.body.terminalDefaultHarness, 'claude');
    assert.equal(old.write.body.terminalClaudeSkipPermissions, true);
    assert.equal(old.write.body.codexYolo, true);
    assert.deepEqual(old.write.body.metricsIgnoredExts, ['.a-saved']);

    await switchProject(B, B_SETTINGS);
    assert.deepEqual(latest.launch, normalizeTerminalLaunchSettings(B_SETTINGS));
    assert.deepEqual(latest.startup, B_SETTINGS.startupTerminals);
    assert.deepEqual(latest.metrics, B_SETTINGS.metricsIgnoredExts);
    editNewSession();
    const expected = snapshot();
    await settle(old.write, outcome, old.done);
    assertEditorSurvives(expected);
    assert.equal(requests.filter((r) => r.method === 'PATCH').length, 1,
      'an obsolete metrics callback must not issue another PATCH');
    if (outcome === 'success') {
      assert.deepEqual(requests.find((r) => r.url === '/api/project-instrumentation')?.body, { project: A });
    }

    // A later deliberate save of B must persist B's drafts and permission defaults.
    const current = await startSave();
    assert.equal(new URL(current.write.url, 'http://localhost').searchParams.get('project'), B);
    assert.equal(current.write.body.terminalDefaultHarness, 'pi');
    assert.equal(current.write.body.terminalClaudeSkipPermissions, false);
    assert.equal(current.write.body.codexYolo, false);
    assert.deepEqual(current.write.body.startupTerminals, expected.draftStartup);
    await settle(current.write, 'success', current.done);
    assert.equal(latest.open, false);
    assert.equal(closes, 1);
  });

  test(`late global-save ${outcome} cannot settle B's pending save`, async () => {
    await mount();
    editTabs('npm run a-saved', '.a-saved');
    const old = await startSave(true);
    await act(async () => { old.write.resolve(); await flush(); });
    const globalWrite = writes.at(-1)!;
    assert.equal(globalWrite.url, '/api/global-settings');
    assert.deepEqual(globalWrite.body.piProviders, PROVIDERS);

    await switchProject(B, B_SETTINGS);
    editNewSession();
    const expected = snapshot();
    const current = await startSave();
    await settle(globalWrite, outcome, old.done);
    assertEditorSurvives(expected, true);
    await settle(current.write, 'success', current.done);
    assert.equal(latest.open, false);
    assert.equal(closes, 1);
  });

  test(`late metrics-callback ${outcome} cannot close or settle the next editor`, async () => {
    await mount();
    editTabs('npm run a-saved', '.a-saved');
    const old = await startSave();
    holdMetrics = true;
    await act(async () => { old.write.resolve(); await flush(); });
    const metricsWrite = writes.at(-1)!;
    assert.deepEqual(metricsWrite.body, { metricsIgnoredExts: ['.a-saved'] });
    assert.equal(new URL(metricsWrite.url, 'http://localhost').searchParams.get('project'), A);
    assert.equal(published.length, 3, 'callbacks started while A was still current');

    await switchProject(B, B_SETTINGS);
    editNewSession();
    published = []; // Only publications after switching would be obsolete.
    const expected = snapshot();
    await settle(metricsWrite, outcome, old.done);
    assertEditorSurvives(expected);
  });

  test(`late save ${outcome} is fenced across A -> B -> A`, async () => {
    await mount();
    editTabs('npm run a-saved', '.a-saved');
    const old = await startSave();
    await switchProject(B, B_SETTINGS);
    settingsReads.set(A, deferred<JsonResponse>());
    await switchProject(A, { ...B_SETTINGS, startupTerminals: A_SETTINGS.startupTerminals });
    editNewSession();
    const expected = snapshot();
    await settle(old.write, outcome, old.done);
    assertEditorSurvives(expected);
  });

  test(`late save ${outcome} is fenced across close/reopen of the same project`, async () => {
    await mount();
    editTabs('npm run a-saved', '.a-saved');
    const old = await startSave();
    await act(async () => { latest.setOpen(false); await flush(); });
    await act(async () => { latest.setOpen(true); await flush(); });
    editNewSession();
    const expected = snapshot();
    await settle(old.write, outcome, old.done);
    assertEditorSurvives(expected);
  });

  test(`a no-project global-save ${outcome} cannot close a newly opened project's editor`, async () => {
    await mount('');
    const old = await startSave(true);
    assert.equal(old.write.url, '/api/global-settings');
    await switchProject(B, B_SETTINGS);
    editNewSession();
    const expected = snapshot();
    await settle(old.write, outcome, old.done);
    assertEditorSurvives(expected);
  });
}

test('a current-session save publishes all saved values and closes normally', async () => {
  await mount();
  act(() => {
    latest.drafts.setTerminalDefaultHarness('pi');
    latest.drafts.setTerminalClaudeSkipPermissions(false);
    latest.drafts.setCodexYolo(false);
  });
  editTabs(' npm run a-saved ', '.a-saved');
  const current = await startSave();
  await settle(current.write, 'success', current.done);
  assert.deepEqual(latest.launch, {
    terminalDefaultHarness: 'pi', terminalClaudeSkipPermissions: false, codexYolo: false,
  });
  assert.deepEqual(latest.startup, [{ id: 'a', label: 'A', command: 'npm run a-saved' }]);
  assert.deepEqual(latest.metrics, ['.a-saved']);
  assert.deepEqual(published, [
    { folder: A, kind: 'startup' }, { folder: A, kind: 'launch' }, { folder: A, kind: 'metrics' },
  ]);
  assert.equal(closes, 1);
  assert.equal(latest.open, false);
  assert.equal(latest.controller.saving, false);
  assert.equal(latest.controller.error, null);
});

test('a late failure cannot replace the current editor\'s own save error', async () => {
  await mount();
  const old = await startSave();
  await switchProject(B, B_SETTINGS);
  editNewSession();
  const expected = snapshot();
  const current = await startSave();
  await settle(current.write, 'failure', current.done, 'B save failed');
  assertEditorSurvives(expected, false, 'B save failed');
  await settle(old.write, 'failure', old.done);
  assertEditorSurvives(expected, false, 'B save failed');
});

test('an accepted save persists after unmount without publishing or closing', async () => {
  await mount();
  editTabs('npm run a-saved', '.a-saved');
  const old = await startSave(true);
  await act(async () => { renderer!.unmount(); renderer = undefined; });
  await act(async () => { old.write.resolve(); await flush(); });
  const globalWrite = writes.at(-1)!;
  assert.equal(globalWrite.url, '/api/global-settings');
  await settle(globalWrite, 'success', old.done);
  assert.deepEqual(published, []);
  assert.equal(closes, 0);
});
