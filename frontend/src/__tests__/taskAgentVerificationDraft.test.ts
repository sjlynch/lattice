// Verification opt-ins must only patch edited fields, including while settings
// load late or fail. Closing or switching projects must discard those patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useTaskAgentVerificationDraft } from '../components/settings/InstructionTemplatesTab';
import { installGlobal } from './domDoubles';

type Draft = ReturnType<typeof useTaskAgentVerificationDraft>;

test('verification checkbox drafts: untouched is undefined, flips patch independently, late GET preserves edits', async (t) => {
  t.after(installGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  let resolveFetch!: (response: unknown) => void;
  t.after(installGlobal('fetch', () => new Promise((resolve) => { resolveFetch = resolve; })));
  let draft!: Draft;
  function Harness({ open, folder }: { open: boolean; folder: string }) {
    draft = useTaskAgentVerificationDraft(open, folder);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { open: true, folder: 'C:/a' }));
  });
  t.after(() => { act(() => renderer.unmount()); });
  assert.equal(draft.tests, false);
  assert.equal(draft.testsPatch, undefined);
  assert.equal(draft.typecheckPatch, undefined);

  act(() => draft.setTests(true));
  assert.equal(draft.testsPatch, true);
  assert.equal(draft.typecheckPatch, undefined);
  await act(async () => {
    resolveFetch({ ok: true, json: async () => ({ taskAgentTests: false, taskAgentTypecheck: true }) });
  });
  assert.equal(draft.tests, true, 'late GET preserves the user flip');
  assert.equal(draft.testsPatch, true);
  assert.equal(draft.typecheck, true, 'untouched field is seeded');
  assert.equal(draft.typecheckPatch, undefined);
  act(() => draft.setTests(false));
  assert.equal(draft.testsPatch, false, 'flipping off must save false');
  act(() => draft.setTypecheck(false));
  assert.equal(draft.typecheckPatch, false);

  await act(async () => {
    renderer.update(React.createElement(Harness, { open: true, folder: 'C:/b' }));
  });
  assert.equal(draft.testsPatch, undefined);
  assert.equal(draft.typecheckPatch, undefined);
  await act(async () => {
    resolveFetch({ ok: true, json: async () => ({ taskAgentTests: true }) });
  });
  assert.equal(draft.tests, true);
  assert.equal(draft.testsPatch, undefined, 'loading true does not produce a patch');
  act(() => draft.setTests(false));
  await act(async () => {
    renderer.update(React.createElement(Harness, { open: false, folder: 'C:/b' }));
  });
  assert.equal(draft.testsPatch, undefined);
});

test('failed settings GET leaves targeted tests untouched until flipped', async (t) => {
  t.after(installGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  t.after(installGlobal('fetch', async () => { throw new TypeError('offline'); }));
  let draft!: Draft;
  function Harness() {
    draft = useTaskAgentVerificationDraft(true, 'C:/a');
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
  t.after(() => { act(() => renderer.unmount()); });
  assert.equal(draft.testsPatch, undefined);
  act(() => draft.setTests(true));
  assert.equal(draft.testsPatch, true);
  assert.equal(draft.typecheckPatch, undefined);
});
