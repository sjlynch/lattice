// Review badges expose only actionable states; draft edits survive slow loads
// and stay out of unrelated saves, including after a project/session change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import type { Task } from '../api';
import { TaskReviewBadge } from '../components/taskboard/TaskCardSubcomponents';
import { TaskDetailMeta } from '../components/taskboard/TaskDetailMeta';
import { LANE_BY_ID } from '../components/taskboard/lanes';
import { useTaskReviewDraft } from '../components/settings/useTaskReviewDraft';
import { installGlobal } from './domDoubles';

const task: Task = { id: 't_1', title: 'Fix', projectPath: 'C:/project', createdAt: 1, status: 'in_progress' };

test('review badges render Reviewing, Doubtful with its reason, and Re-running only', (t) => {
  t.after(installGlobal('React', React));
  for (const [status, label] of [['reviewing', 'Reviewing…'], ['rejected', 'Doubtful'], ['rerun', 'Re-running'],
    ['accepted', ''], ['error', '']] as const) {
    const row: Task = { ...task, review: { status, head: 'abc', attempt: 1, startedAt: 1, reason: 'Misses an edge case' } };
    const markup = renderToStaticMarkup(React.createElement(TaskReviewBadge, { task: row }));
    if (label) {
      assert.ok(markup.includes(label));
      assert.ok(markup.includes('title="Misses an edge case"'));
    } else assert.equal(markup, '');
  }
  assert.equal(renderToStaticMarkup(React.createElement(TaskReviewBadge, { task })), '');
});

test('detail review line shows verdict, probability, reviewer and reason, including errors', (t) => {
  t.after(installGlobal('React', React));
  const markup = renderToStaticMarkup(React.createElement(TaskDetailMeta, {
    task: { ...task, review: { status: 'rejected', head: 'abc', attempt: 1, startedAt: 1, p: 0,
      reviewer: 'codex/gpt-6.1-sol', reason: 'Missing fallback' } }, lane: LANE_BY_ID.in_progress,
  }));
  for (const value of ['Second opinion:', 'rejected', '0%', 'codex/gpt-6.1-sol', 'Missing fallback']) assert.ok(markup.includes(value));
});

test('review settings draft patches only edited fields and late GET cannot overwrite edits', async (t) => {
  t.after(installGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  const responses: ((response: unknown) => void)[] = [];
  t.after(installGlobal('fetch', () => new Promise((resolve) => responses.push(resolve))));
  let draft!: ReturnType<typeof useTaskReviewDraft>;
  function Harness({ open, project }: { open: boolean; project: string }) {
    draft = useTaskReviewDraft(open, project);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { open: true, project: 'C:/a' })); });
  t.after(() => { act(() => renderer.unmount()); });
  assert.equal(draft.getPatch(), undefined);
  act(() => draft.set({ taskReview: 'rerun', taskReviewRerunHarness: 'pi', taskReviewRerunPiModel: 'local/strong' }));
  await act(async () => { responses[0]({ ok: true, json: async () => ({ taskReview: 'off', taskReviewModel: 'saved-reviewer' }) }); });
  assert.equal(draft.values.taskReview, 'rerun');
  assert.equal(draft.values.taskReviewModel, 'saved-reviewer');
  assert.deepEqual(draft.getPatch(), { taskReview: 'rerun', taskReviewRerunHarness: 'pi', taskReviewRerunPiModel: 'local/strong' });
  act(() => draft.set({ taskReviewRerunHarness: undefined, taskReviewRerunEffort: undefined }));
  assert.equal(draft.getPatch()!.taskReviewRerunHarness, null, 'clear is serialized instead of dropped');
  await act(async () => { renderer.update(React.createElement(Harness, { open: true, project: 'C:/b' })); });
  assert.equal(draft.getPatch(), undefined);
  await act(async () => { renderer.update(React.createElement(Harness, { open: true, project: 'C:/a' })); });
  await act(async () => { responses[1]({ ok: true, json: async () => ({ taskReview: 'flag' }) }); });
  assert.equal(draft.values.taskReview, undefined, 'old session response is ignored');
  act(() => draft.set({ taskReview: 'off' }));
  await act(async () => { responses[2]({ ok: true, json: async () => ({ taskReview: 'rerun' }) }); });
  assert.deepEqual(draft.getPatch(), { taskReview: 'off' });
  await act(async () => { renderer.update(React.createElement(Harness, { open: false, project: 'C:/a' })); });
  assert.equal(draft.getPatch(), undefined);
});

test('failed settings load never writes defaults; editing remains possible', async (t) => {
  t.after(installGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  t.after(installGlobal('fetch', async () => { throw new TypeError('offline'); }));
  let draft!: ReturnType<typeof useTaskReviewDraft>;
  function Harness() { draft = useTaskReviewDraft(true, 'C:/a'); return null; }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
  t.after(() => { act(() => renderer.unmount()); });
  assert.equal(draft.getPatch(), undefined);
  act(() => draft.set({ taskReview: 'flag' }));
  assert.deepEqual(draft.getPatch(), { taskReview: 'flag' });
});
