import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { installGlobal } from './domDoubles.ts';
import type { GlobalSettings, PiModelsResult, PiProvider } from '../api';
import { PiTab, type PiTabHandle } from '../components/settings/PiTab.tsx';
import { PiModelMenu } from '../components/settings/PiModelMenu.tsx';
import { PiEndpointCard } from '../components/settings/PiEndpointCard.tsx';
import { saveGlobalSettings } from '../components/settings/saveSettings.ts';

const MANUAL: PiProvider = {
  id: 'local', baseUrl: 'http://localhost:8000/v1', autoDiscover: false,
  models: [{ id: 'qwen' }],
};

function menuResult(
  patterns = ['builtin/curated', 'builtin/hidden', 'local/qwen'],
  selected = ['builtin/curated', 'local/qwen'],
): PiModelsResult {
  return {
    models: patterns.map((pattern) => {
      const [provider, ...model] = pattern.split('/');
      return { provider, model: model.join('/'), pattern };
    }),
    menu: selected.map((pattern) => ({ pattern, label: pattern })),
    defaultPattern: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function response(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function mount(t: TestContext, providers: PiProvider[] = [MANUAL]) {
  const loads: Array<ReturnType<typeof deferred<Response>>> = [];
  const patches: Partial<GlobalSettings>[] = [];
  let refreshAfterSave = false;
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('React', React),
    installGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
      if (url === '/api/global-settings') {
        if (init?.method === 'PATCH') {
          const patch = JSON.parse(init.body ?? '{}') as Partial<GlobalSettings>;
          patches.push(patch);
          refreshAfterSave = true;
          return Promise.resolve(response({ maxConcurrentAgents: 1, piProviders: providers, ...patch }));
        }
        // Endpoint settings land first, exposing their menu rows while the
        // separate saved-menu GET is still pending.
        return Promise.resolve(response({ maxConcurrentAgents: 1, piProviders: providers }));
      }
      assert.equal(url, '/api/pi-models');
      if (refreshAfterSave) {
        refreshAfterSave = false;
        return Promise.resolve(response(menuResult()));
      }
      const load = deferred<Response>();
      loads.push(load);
      return load.promise;
    }),
  ];
  const ref = React.createRef<PiTabHandle>();
  let renderer!: ReturnType<typeof TestRenderer.create>;
  t.after(() => {
    act(() => renderer?.unmount());
    for (const reset of restore.reverse()) reset();
  });
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(PiTab, { ref, active: true, open: true }));
    await flush();
  });
  assert.equal(loads.length, 1);
  const menu = () => renderer.root.findByType(PiModelMenu);
  const box = (pattern: string) => menu().findAllByType('label')
    .find((label) => label.findAllByType('span').some((span) => text(span) === pattern))!
    .findByType('input');
  return {
    ref, renderer, loads, patches, menu, box,
    patchEndpoint(partial: Partial<PiProvider>, index = 0) {
      act(() => renderer.root.findAllByType(PiEndpointCard)[index].props.onPatch(partial));
    },
    toggle(pattern: string) {
      // Invoke even a disabled input's handler to exercise the hook's own
      // mutation guard independently of the browser's disabled behavior.
      act(() => box(pattern).props.onChange());
    },
    async resolveLoad(index: number, result = menuResult()) {
      await act(async () => { loads[index].resolve(response(result)); await flush(); });
    },
    async rejectLoad(index: number, message = 'backend restarting') {
      await act(async () => { loads[index].reject(new Error(message)); await flush(); });
    },
    async setOpen(open: boolean) {
      await act(async () => {
        renderer.update(React.createElement(PiTab, { ref, active: true, open }));
        await flush();
      });
    },
    async retry() {
      await act(async () => {
        menu().findAllByType('button')
          .find((button) => text(button) === 'Retry loading Pi model menu')!.props.onClick();
        await flush();
      });
    },
    async save() {
      await act(async () => {
        await saveGlobalSettings({ agents: null, pi: ref.current, tools: null });
        await flush();
      });
    },
  };
}

test('faster endpoint loading exposes read-only rows until the saved menu lands', async (t) => {
  const tab = await mount(t);
  assert.equal(tab.menu().props.loaded, false);
  assert.equal(tab.box('local/qwen').props.disabled, true);
  assert.match(text(tab.menu().findByProps({ role: 'status' })), /Loading.*read-only/);

  const before = [...tab.menu().props.selected];
  tab.toggle('local/qwen');
  assert.deepEqual([...tab.menu().props.selected], before, 'the mutation entry point is gated');
  assert.equal(tab.ref.current!.getPiModelMenuPatch(), undefined);
  await tab.save();
  assert.deepEqual(tab.patches, [], 'an unloaded save leaves the curated menu alone');

  await tab.resolveLoad(0);
  assert.equal(tab.box('local/qwen').props.disabled, false);
  assert.equal(tab.box('local/qwen').props.checked, true);
  assert.equal(tab.box('builtin/hidden').props.checked, false);
  assert.equal(tab.ref.current!.getPiModelMenuPatch(), undefined, 'blocked edits never mark touched');
  tab.toggle('local/qwen');
  await tab.save();
  assert.deepEqual(tab.patches, [{ piModelMenu: ['builtin/curated'] }]);
});

test('close/reopen retains rows but gates their edits and patches until the new load', async (t) => {
  const tab = await mount(t);
  await tab.resolveLoad(0);
  tab.toggle('local/qwen');
  assert.deepEqual(tab.ref.current!.getPiModelMenuPatch(), ['builtin/curated']);

  await tab.setOpen(false);
  assert.equal(tab.ref.current!.getPiModelMenuPatch(), undefined, 'closed drafts cannot save');
  await tab.setOpen(true);
  assert.equal(tab.loads.length, 2);
  assert.equal(tab.box('builtin/curated').props.disabled, true, 'prior saved rows stay read-only');
  const before = [...tab.menu().props.selected];
  tab.toggle('builtin/curated');
  assert.deepEqual([...tab.menu().props.selected], before);
  await tab.save();
  assert.deepEqual(tab.patches, []);

  await tab.resolveLoad(1);
  assert.equal(tab.box('local/qwen').props.checked, true, 'the current saved baseline replaces cancelled edits');
  assert.equal(tab.ref.current!.getPiModelMenuPatch(), undefined);
});

test('a failed menu load is visible and read-only; Retry enables savable edits', async (t) => {
  const tab = await mount(t);
  await tab.rejectLoad(0);
  assert.match(text(tab.menu().findByProps({ role: 'alert' })), /backend restarting.*read-only.*unchanged/);
  assert.equal(tab.box('local/qwen').props.disabled, true);
  tab.toggle('local/qwen');
  assert.equal(tab.ref.current!.getPiModelMenuPatch(), undefined);
  await tab.save();
  assert.deepEqual(tab.patches, []);

  await tab.retry();
  assert.equal(tab.loads.length, 2);
  assert.equal(tab.menu().findAllByProps({ role: 'alert' }).length, 0);
  assert.equal(tab.box('local/qwen').props.disabled, true);
  await tab.resolveLoad(1);
  tab.toggle('local/qwen');
  await tab.save();
  assert.deepEqual(tab.patches, [{ piModelMenu: ['builtin/curated'] }]);
});

test('a failed reopen leaves retained rows read-only and cannot save cancelled selections', async (t) => {
  const tab = await mount(t);
  await tab.resolveLoad(0);
  tab.toggle('local/qwen');
  await tab.setOpen(false);
  await tab.setOpen(true);
  await tab.rejectLoad(1);
  assert.equal(tab.box('builtin/curated').props.disabled, true);
  assert.equal(tab.box('local/qwen').props.disabled, true);
  assert.match(text(tab.menu().findByProps({ role: 'alert' })), /backend restarting/);
  tab.toggle('builtin/curated');
  assert.equal(tab.box('builtin/curated').props.checked, true);
  assert.equal(tab.ref.current!.getPiModelMenuPatch(), undefined);
  await tab.save();
  assert.deepEqual(tab.patches, []);
});

test('no-models empty state appears only after a successful menu load', async (t) => {
  const tab = await mount(t, []);
  assert.match(text(tab.menu()), /Loading saved Pi model menu/);
  assert.doesNotMatch(text(tab.menu()), /No Pi models detected/);
  await tab.rejectLoad(0);
  assert.doesNotMatch(text(tab.menu()), /No Pi models detected/);
  await tab.retry();
  await tab.resolveLoad(1, menuResult([], []));
  assert.match(text(tab.menu()), /No Pi models detected/);
});

for (const failure of [false, true]) {
  test(`provider edits cannot clobber a ${failure ? 'failed' : 'pending'} saved menu`, async (t) => {
    const tab = await mount(t);
    if (failure) await tab.rejectLoad(0);
    tab.patchEndpoint({ models: [{ id: 'qwen' }, { id: 'new' }] });
    assert.equal(tab.box('local/new').props.disabled, true);
    assert.equal(tab.ref.current!.getPiModelMenuPatch(), undefined);
    await tab.save();
    assert.deepEqual(tab.patches, [{ piProviders: [{ ...MANUAL, models: [{ id: 'qwen' }, { id: 'new' }] }] }]);
  });
}

test('hydration includes new provider patterns without re-adding unchecked models', async (t) => {
  const tab = await mount(t);
  tab.patchEndpoint({ models: [{ id: 'qwen' }, { id: 'new' }] });
  await tab.resolveLoad(0);
  assert.deepEqual(tab.ref.current!.getPiModelMenuPatch(), ['builtin/curated', 'local/qwen', 'local/new']);
  assert.equal(tab.box('local/new').props.checked, true, 'a pattern added before hydration is included afterwards');
  tab.toggle('local/new');
  tab.patchEndpoint({ models: [{ id: 'qwen' }, { id: 'new' }, { id: 'later' }] });
  assert.equal(tab.box('local/new').props.checked, false);
  assert.equal(tab.box('local/later').props.checked, true);
  assert.deepEqual(tab.ref.current!.getPiModelMenuPatch(), ['builtin/curated', 'local/qwen', 'local/later']);
});

test('auto-discovered rows remain fixed after the saved menu loads', async (t) => {
  const auto = { ...MANUAL, id: 'auto', autoDiscover: true };
  const tab = await mount(t, [MANUAL, auto]);
  assert.equal(tab.box('auto/qwen').props.checked, true);
  assert.equal(tab.box('auto/qwen').props.disabled, true);
  await tab.resolveLoad(0, menuResult(
    ['builtin/curated', 'local/qwen', 'auto/qwen'], ['builtin/curated'],
  ));
  assert.equal(tab.box('local/qwen').props.disabled, false);
  assert.equal(tab.box('auto/qwen').props.checked, true);
  assert.equal(tab.box('auto/qwen').props.disabled, true);
});

for (const fails of [false, true]) {
  test(`a cancelled menu ${fails ? 'failure' : 'success'} cannot settle a reopened draft`, async (t) => {
    const tab = await mount(t);
    await tab.setOpen(false);
    await tab.setOpen(true);
    await tab.resolveLoad(1);
    tab.toggle('local/qwen');
    if (fails) await tab.rejectLoad(0, 'obsolete failure');
    else await tab.resolveLoad(0, menuResult(['obsolete/model'], ['obsolete/model']));
    assert.equal(tab.menu().props.loaded, true);
    assert.equal(tab.menu().props.loadError, null);
    assert.deepEqual(tab.ref.current!.getPiModelMenuPatch(), ['builtin/curated']);
    assert.equal(tab.box('local/qwen').props.checked, false);
    assert.equal(tab.menu().props.patterns.includes('obsolete/model'), false);
  });
}
