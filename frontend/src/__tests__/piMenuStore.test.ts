import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiMenuStore } from '../piMenuStoreCore.ts';
import type { PiMenuEntry } from '../api';

const entry = (pattern: string): PiMenuEntry => ({ pattern, label: pattern });

test('ensure() fetches once and notifies subscribers with the menu', async () => {
  let calls = 0;
  const store = createPiMenuStore(async () => {
    calls += 1;
    return [entry('vllm/qwen')];
  });

  let notified = 0;
  const unsub = store.subscribe(() => {
    notified += 1;
  });

  assert.equal(store.isLoaded(), false);
  await store.ensure();
  assert.equal(calls, 1);
  assert.equal(store.isLoaded(), true);
  assert.deepEqual(store.getMenu().map((m) => m.pattern), ['vllm/qwen']);
  assert.equal(notified, 1);

  // A second ensure() after a completed load is a no-op (no refetch).
  await store.ensure();
  assert.equal(calls, 1);
  unsub();
});

test('concurrent ensure() calls share a single in-flight fetch', async () => {
  let calls = 0;
  let resolve!: (m: PiMenuEntry[]) => void;
  const store = createPiMenuStore(() => {
    calls += 1;
    return new Promise<PiMenuEntry[]>((res) => {
      resolve = res;
    });
  });

  const a = store.ensure();
  const b = store.ensure();
  assert.equal(calls, 1, 'second ensure must not start a second fetch');

  resolve([entry('vllm/qwen')]);
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

// The regression: a Settings → Pi save fires notifyPiModelsChanged() → refresh().
// Already-mounted dropdowns (the subscribers) must refetch and re-render with the
// new menu, without a page reload.
test('refresh() refetches and notifies mounted subscribers with the updated menu', async () => {
  const menus = [[entry('vllm/qwen')], [entry('vllm/qwen'), entry('local/llama')]];
  let calls = 0;
  const store = createPiMenuStore(async () => menus[Math.min(calls++, menus.length - 1)]);

  const seen: number[] = [];
  store.subscribe(() => {
    seen.push(store.getMenu().length);
  });

  await store.ensure(); // initial load → 1 entry
  assert.deepEqual(store.getMenu().map((m) => m.pattern), ['vllm/qwen']);

  await store.refresh(); // settings saved → refetch → 2 entries
  assert.equal(calls, 2, 'refresh must always refetch even when already loaded');
  assert.deepEqual(store.getMenu().map((m) => m.pattern), ['vllm/qwen', 'local/llama']);

  // The mounted subscriber saw both the initial load and the post-save refresh.
  assert.deepEqual(seen, [1, 2]);
});

test('a failed fetch keeps the prior cached menu and still notifies', async () => {
  let calls = 0;
  const store = createPiMenuStore(async () => {
    calls += 1;
    if (calls === 2) throw new Error('network down');
    return [entry('vllm/qwen')];
  });

  await store.ensure();
  assert.deepEqual(store.getMenu().map((m) => m.pattern), ['vllm/qwen']);

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  await store.refresh(); // throws internally — cache preserved
  assert.deepEqual(store.getMenu().map((m) => m.pattern), ['vllm/qwen']);
  assert.equal(notified, 1);
});

test('getMenu returns a stable reference between loads (useSyncExternalStore-safe)', async () => {
  const store = createPiMenuStore(async () => [entry('vllm/qwen')]);
  await store.ensure();
  const first = store.getMenu();
  assert.equal(store.getMenu(), first, 'identity must be stable without a reload');
});

test('getPiModels rejects on a failed request instead of reading as an empty menu', async () => {
  const { getPiModels } = await import('../api/settings.ts');
  const g = globalThis as { fetch: typeof fetch };
  const original = g.fetch;
  g.fetch = (async () =>
    ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) as unknown as Response) as typeof fetch;
  try {
    // An empty `{models: [], menu: []}` here would let a Settings → Pi save
    // persist a menu missing every curated pattern, and would blank the shared
    // dropdown cache.
    await assert.rejects(getPiModels());
  } finally {
    g.fetch = original;
  }
});
