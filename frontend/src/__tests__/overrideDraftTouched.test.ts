import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { UserSettings } from '../api';
import {
  useOverrideDraft,
  type OverrideDraft,
} from '../components/settings/useOverrideDraft.ts';

// Regression: the two "override-merge" Settings tabs (Agent prompts / Env
// notes) wire useOverrideDraft.getPatch() as their dirty signal. The bug was
// that getPatch() returned non-undefined for the entire dialog session as soon
// as the seeding fetch settled — so simply *clicking* the tab (which triggers
// the load) latched the tab dirty, producing a spurious "unsaved settings
// changes" confirm on close with no edit made. The fix gates getPatch() behind
// a `touched` flag: undefined until the user actually edits a draft. This drives
// the real hook headlessly (react-test-renderer) across mount -> load -> edit.

type Item = { id: string; def: string; cur: string };

// `cur === def` for the seeded item: the would-be patch is `{}` (key dropped as
// matching default). Before the fix getPatch() returned that `{}` (non-undefined
// → "dirty") the moment the load settled; after the fix it stays undefined until
// an edit.
const ITEMS: Item[] = [{ id: 'a', def: 'DEFAULT TEXT', cur: 'DEFAULT TEXT' }];

const config = {
  fetchItems: () => Promise.resolve(ITEMS),
  readOverrides: (_s: UserSettings) => ({}) as Record<string, string>,
  idOf: (i: Item) => i.id,
  defaultOf: (i: Item) => i.def,
  currentOf: (i: Item) => i.cur,
  // Mirror InstructionTemplatesTab: drop the override when blank or exactly default.
  matchesDefault: (draft: string, i: Item) =>
    draft.trim().length === 0 || draft === i.def,
};

// The hook's most recently rendered handle, captured each render. getPatch /
// setDraft are non-reactive, so we always read the latest render's closures.
let latest: OverrideDraft<Item>;
function Harness({ open, active, folder }: { open: boolean; active: boolean; folder: string }) {
  latest = useOverrideDraft<Item>({ ...config, open, active, activeFolder: folder });
  return null;
}

// Flush the fetch/Promise.all microtask chain (fetchItems + fetchUserSettings ->
// json -> setState) inside act so React commits the resulting renders.
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
  // useOverrideDraft -> fetchUserSettings hits `fetch('/api/settings?...')`;
  // resolve it with empty settings (no existing overrides).
  g.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

test('an unedited (merely-opened) override tab reports no patch; editing flips it', async () => {
  let renderer: ReturnType<typeof TestRenderer.create> | null = null;

  // Mount with the tab open + active: this triggers the seeding load.
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { open: true, active: true, folder: 'C:/project' }),
    );
  });
  await flush();

  // The load has settled but the user changed nothing — getPatch() must be
  // undefined so computeDirty().prompts stays false (no spurious unsaved warn).
  assert.equal(
    latest.getPatch(),
    undefined,
    'a loaded-but-untouched tab must not report a patch',
  );

  // Now the user actually edits a draft: the tab becomes dirty and the patch
  // carries the override.
  act(() => {
    latest.setDraft('a', 'EDITED TEXT');
  });
  assert.deepEqual(
    latest.getPatch(),
    { a: 'EDITED TEXT' },
    'after an edit the patch reflects the override and the tab is dirty',
  );

  act(() => {
    renderer!.unmount();
  });
});

test('resetAll counts as an edit (touched), even though it restores defaults', async () => {
  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { open: true, active: true, folder: 'C:/project' }),
    );
  });
  await flush();

  assert.equal(latest.getPatch(), undefined, 'untouched after load');

  // resetAll writes every draft back to its default. The resulting patch is `{}`
  // (all keys dropped), but the tab is now touched, so getPatch() is defined —
  // a deliberate reset is a real, savable action.
  act(() => {
    latest.resetAll();
  });
  assert.deepEqual(latest.getPatch(), {}, 'reset-to-default is a defined (empty) patch once touched');

  act(() => {
    renderer!.unmount();
  });
});
