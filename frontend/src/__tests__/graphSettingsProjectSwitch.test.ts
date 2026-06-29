import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type GraphSettings } from '../components/forceGraph/graphSettings.ts';
import {
  scopedGraphSettingsForProject,
  settingsForActiveProject,
  shouldPersistScopedGraphSettings,
  type ScopedGraphSettings,
} from '../components/forceGraph/hooks/usePerProjectGraphSettings.ts';
import { latticeStorageKeys } from '../storage/latticeLocalStorage.ts';

const A = 'C:/proj-a';
const B = 'C:/proj-b';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = fakeStorage();
});

function settings(patch: Partial<GraphSettings>): GraphSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function persistIfAllowed(activeFolder: string, scoped: ScopedGraphSettings): void {
  if (!shouldPersistScopedGraphSettings(activeFolder, scoped)) return;
  localStorage.setItem(
    latticeStorageKeys.graphSettings(activeFolder),
    JSON.stringify(scoped.settings),
  );
}

test('REGRESSION: project switch does not persist project A graph settings under B', () => {
  const aSettings = settings({ fileNodeSize: 21, repulsionMode: 'nbody' });
  const bSettings = settings({ fileNodeSize: 7, repulsionMode: 'local' });
  localStorage.setItem(latticeStorageKeys.graphSettings(A), JSON.stringify(aSettings));
  localStorage.setItem(latticeStorageKeys.graphSettings(B), JSON.stringify(bSettings));

  const scopedA = scopedGraphSettingsForProject(A);
  assert.equal(scopedA.settings.fileNodeSize, 21);

  // Danger render after activeFolder changes: React props say B, but the tagged
  // state object is still the one loaded for A until the project-load effect
  // commits. The UI should read B's saved settings and persistence must skip.
  assert.equal(settingsForActiveProject(B, scopedA).fileNodeSize, 7);
  persistIfAllowed(B, scopedA);
  assert.deepEqual(
    JSON.parse(localStorage.getItem(latticeStorageKeys.graphSettings(B)) ?? '{}'),
    bSettings,
  );

  const scopedB = scopedGraphSettingsForProject(B);
  persistIfAllowed(B, scopedB);
  assert.deepEqual(
    JSON.parse(localStorage.getItem(latticeStorageKeys.graphSettings(B)) ?? '{}'),
    bSettings,
  );
});

test('settings tagged with the active project persist normally', () => {
  const scoped: ScopedGraphSettings = {
    project: A,
    settings: settings({ labelSize: 10 }),
  };
  persistIfAllowed(A, scoped);
  assert.equal(
    JSON.parse(localStorage.getItem(latticeStorageKeys.graphSettings(A)) ?? '{}').labelSize,
    10,
  );
});
