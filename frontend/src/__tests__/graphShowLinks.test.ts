import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../components/forceGraph/graphSettings.ts';
import { latticeStorageKeys } from '../storage/latticeLocalStorage.ts';

// Graph settings → Rendering → "Show links". Links must render by default,
// including for projects whose saved settings predate the field.

const P = 'C:/proj';

beforeEach(() => {
  const map = new Map<string, string>();
  (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  } as Storage;
});

test('links render by default', () => {
  assert.equal(DEFAULT_SETTINGS.showLinks, true);
  assert.equal(loadSettings(P).showLinks, true);
});

test('settings saved before "Show links" existed still render links', () => {
  const { showLinks: _dropped, ...legacy } = DEFAULT_SETTINGS;
  localStorage.setItem(latticeStorageKeys.graphSettings(P), JSON.stringify({ ...legacy, fileNodeSize: 20 }));
  const loaded = loadSettings(P);
  assert.equal(loaded.showLinks, true);
  assert.equal(loaded.fileNodeSize, 20);
});

test('turning links off persists per project', () => {
  saveSettings(P, { ...DEFAULT_SETTINGS, showLinks: false });
  assert.equal(loadSettings(P).showLinks, false);
  assert.equal(loadSettings('C:/other').showLinks, true);
});
