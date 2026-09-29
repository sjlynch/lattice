import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { installGlobal } from './domDoubles.ts';
import { AgentsTab, type AgentsTabHandle } from '../components/settings/AgentsTab.tsx';
import { saveGlobalSettings } from '../components/settings/saveSettings.ts';
import type { GlobalSettings } from '../api/globalSettings.ts';

type FetchResponse = { ok: boolean; json: () => Promise<GlobalSettings> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function response(maxConcurrentAgents: number): FetchResponse {
  return { ok: true, json: async () => ({ maxConcurrentAgents }) };
}

async function mount(t: TestContext) {
  const loads: Array<ReturnType<typeof deferred<FetchResponse>>> = [];
  const patches: Partial<GlobalSettings>[] = [];
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('React', React),
    installGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
      assert.equal(url, '/api/global-settings', 'agent limits stay machine-global');
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(init.body ?? '{}') as Partial<GlobalSettings>;
        patches.push(patch);
        return Promise.resolve(response(patch.maxConcurrentAgents!));
      }
      const load = deferred<FetchResponse>();
      loads.push(load);
      return load.promise;
    }),
  ];
  const ref = React.createRef<AgentsTabHandle>();
  let renderer!: ReturnType<typeof TestRenderer.create>;
  t.after(() => {
    act(() => renderer?.unmount());
    for (const reset of restore.reverse()) reset();
  });
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(AgentsTab, { ref, active: true, open: true }),
    );
  });
  assert.equal(loads.length, 1, 'the initial GET remains pending');

  const input = () => renderer.root.findByProps({ id: 'max-concurrent-agents' });
  return {
    ref,
    renderer,
    loads,
    patches,
    input,
    edit(value: string) {
      act(() => input().props.onChange({ target: { value } }));
    },
    async resolveLoad(index: number, maxConcurrentAgents: number) {
      await act(async () => {
        loads[index].resolve(response(maxConcurrentAgents));
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
    },
    async setOpen(open: boolean) {
      await act(async () => {
        renderer.update(React.createElement(AgentsTab, { ref, active: true, open }));
      });
    },
    save: () => saveGlobalSettings({ agents: ref.current, pi: null, tools: null }),
  };
}

test('an agent limit edited during loading stays visible and is the value saved', async (t) => {
  const tab = await mount(t);
  assert.equal(tab.input().props.disabled, undefined, 'editing is available during loading');
  tab.edit('4');
  assert.equal(tab.input().props.value, '4');
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), 4);

  await tab.resolveLoad(0, 20);

  assert.equal(tab.input().props.value, '4', 'the late GET preserves the edit');
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), 4);
  await tab.save();
  assert.deepEqual(tab.patches, [{ maxConcurrentAgents: 4 }]);
});

test('an untouched agent limit receives the saved value without producing a save patch', async (t) => {
  const tab = await mount(t);
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), undefined);

  await tab.resolveLoad(0, 20);

  assert.equal(tab.input().props.value, '20');
  assert.equal(tab.input().props.min, 1);
  assert.equal(tab.input().props.max, 150);
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), undefined);
  await tab.save();
  assert.deepEqual(tab.patches, [], 'an unrelated save leaves the global limit alone');
});

for (const value of ['', '0', '151', '4.5']) {
  test(`an invalid pre-load agent limit (${JSON.stringify(value)}) keeps its save error`, async (t) => {
    const tab = await mount(t);
    tab.edit(value);
    const error = /Max concurrent agents must be a whole number between 1 and 150\./;
    assert.throws(() => tab.ref.current!.getMaxConcurrentAgentsPatch(), error);

    await tab.resolveLoad(0, 20);

    assert.equal(tab.input().props.value, value, 'the GET must not hide an invalid edit');
    assert.throws(() => tab.ref.current!.getMaxConcurrentAgentsPatch(), error);
    const errors = tab.renderer.root.findAllByProps({ className: 'error-msg' });
    assert.equal(errors.length, 1);
    assert.match(errors[0].children.join(''), /Enter a whole number between 1 and 150\./);
    await assert.rejects(tab.save(), error);
    assert.deepEqual(tab.patches, [], 'invalid input prevents persistence');
  });
}

test('closing cancels a pending agent settings load and reopening starts a fresh load', async (t) => {
  const tab = await mount(t);
  await tab.setOpen(false);
  await tab.resolveLoad(0, 20);
  assert.equal(tab.input().props.value, '', 'the cancelled GET cannot seed a closed tab');
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), undefined);

  await tab.setOpen(true);
  assert.equal(tab.loads.length, 2);
  await tab.resolveLoad(1, 8);
  assert.equal(tab.input().props.value, '8');
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), undefined);
});

test('reopening resets the edit marker and ignores a response from the previous opening', async (t) => {
  const tab = await mount(t);
  tab.edit('4');
  await tab.setOpen(false);
  await tab.setOpen(true);
  assert.equal(tab.loads.length, 2);
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), undefined, 'reopen clears touched');

  await tab.resolveLoad(1, 8);
  assert.equal(tab.input().props.value, '8', 'a new untouched opening seeds the saved value');
  await tab.resolveLoad(0, 20);
  assert.equal(tab.input().props.value, '8', 'the old response cannot overwrite the new load');
  assert.equal(tab.ref.current!.getMaxConcurrentAgentsPatch(), undefined);
});
