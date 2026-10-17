// Task-writing preferences must save only edited fields and retain local edits
// when an initial GET resolves late or the user switches settings tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { installGlobal } from './domDoubles';
import { taskWritingRulesFromText, useTaskWritingDraft } from '../components/settings/useTaskWritingDraft';
import { TaskWritingSection } from '../components/settings/TaskWritingSection';
import { patchUserSettings } from '../api/settings';

test('taskWritingRulesFromText trims each line, drops blanks and handles CRLF', () => {
  assert.deepEqual(taskWritingRulesFromText('  Name exports \r\n\r\n \t \n State errors\n'), ['Name exports', 'State errors']);
  assert.deepEqual(taskWritingRulesFromText(''), []);
});

test('task-writing drafts protect untouched fields, late loads, project changes and reopen', async () => {
  const restoreAct = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const pending: ((response: Response) => void)[] = [];
  const restoreFetch = installGlobal('fetch', () => new Promise<Response>((resolve) => pending.push(resolve)));
  let latest!: ReturnType<typeof useTaskWritingDraft>;
  function Harness({ folder, open }: { folder: string; open: boolean }) {
    latest = useTaskWritingDraft(open, folder);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { folder: 'A', open: true })); });
    assert.equal(latest.getPatch(), undefined);
    act(() => latest.setRulesText(' My rule \n\n Other rule '));
    assert.deepEqual(latest.getPatch(), { taskWritingRules: ['My rule', 'Other rule'] });
    await act(async () => pending.shift()!(Response.json({ taskWritingRules: ['saved'], plannerSpecGaps: false })));
    assert.equal(latest.rulesText, ' My rule \n\n Other rule ');
    assert.equal(latest.showGaps, false);
    assert.deepEqual(latest.getPatch(), { taskWritingRules: ['My rule', 'Other rule'] });
    act(() => latest.setShowGaps(true));
    assert.deepEqual(latest.getPatch(), { taskWritingRules: ['My rule', 'Other rule'], plannerSpecGaps: true });
    await act(async () => renderer.update(React.createElement(Harness, { folder: 'B', open: true })));
    assert.equal(latest.getPatch(), undefined);
    assert.equal(latest.showGaps, true);
    act(() => latest.setShowGaps(false));
    await act(async () => pending.shift()!(Response.json({ taskWritingRules: ['B rule'], plannerSpecGaps: true })));
    assert.equal(latest.rulesText, 'B rule');
    assert.equal(latest.showGaps, false);
    assert.deepEqual(latest.getPatch(), { plannerSpecGaps: false });
    await act(async () => renderer.update(React.createElement(Harness, { folder: 'B', open: false })));
    assert.equal(latest.getPatch(), undefined);
    await act(async () => renderer.update(React.createElement(Harness, { folder: 'B', open: true })));
    assert.equal(latest.getPatch(), undefined);
    await act(async () => pending.shift()!(Response.json({ taskWritingRules: ['fresh'] })));
    assert.equal(latest.rulesText, 'fresh');
    assert.equal(latest.getPatch(), undefined);
  } finally {
    act(() => renderer?.unmount());
    restoreFetch();
    restoreAct();
  }
});

test('recent gap preview fetches on expansion, displays titles, empty and failed states', async () => {
  const restoreAct = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const restoreReact = installGlobal('React', React);
  const urls: string[] = [];
  let mode: 'content' | 'empty' | 'error' = 'content';
  const restoreFetch = installGlobal('fetch', async (url: string) => {
    urls.push(url);
    if (mode === 'error') throw new Error('offline');
    return Response.json({ gaps: mode === 'empty' ? [] : [{ taskId: 't', title: 'Timeout task', gap: 'Picked 30s', at: 1 }] });
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  const draft = { rulesText: '', showGaps: true, setRulesText() {}, setShowGaps() {}, getPatch: () => undefined };
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(TaskWritingSection, { open: true, activeFolder: 'C:/my project', draft })); });
    assert.deepEqual(urls, []);
    const toggle = async (open: boolean) => {
      await act(async () => renderer.root.findByType('details').props.onToggle({ currentTarget: { open } }));
    };
    await toggle(true);
    assert.deepEqual(urls, ['/api/spec-gaps?project=C%3A%2Fmy%20project&limit=25']);
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Picked 30s'));
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Timeout task'));
    await toggle(false);
    mode = 'empty';
    await toggle(true);
    assert.ok(JSON.stringify(renderer.toJSON()).includes('No Spec gaps reported yet. Task agents add them at the end of their summaries.'));
    await toggle(false);
    mode = 'error';
    await toggle(true);
    assert.ok(JSON.stringify(renderer.toJSON()).includes("Couldn't load Spec gaps."));
  } finally {
    act(() => renderer?.unmount());
    restoreFetch();
    restoreAct();
    restoreReact();
  }
});

test('settings validation surfaces the server error message', async () => {
  const error = 'taskWritingRules allows at most 12 rules';
  const restoreFetch = installGlobal('fetch', async () => Response.json({ error }, { status: 400 }));
  try {
    await assert.rejects(patchUserSettings('C:/project', { taskWritingRules: Array(13).fill('rule') }), { message: error });
  } finally {
    restoreFetch();
  }
});
