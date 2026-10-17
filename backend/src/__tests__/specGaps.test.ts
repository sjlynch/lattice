// Implementer reports are appended Markdown: only the final report should teach
// planners, with bounded items, newest-first deduplication, and stable rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecGaps, recentSpecGaps, renderTaskWritingGuidance, type RecentSpecGap } from '../specGaps.js';
import type { Task } from '../tasks.js';

test('parseSpecGaps: documented examples, absent and appended markers', () => {
  const examples: [string, string[]][] = [
    ['- Added X\n\nSpec gaps: none', []],
    ['Did it.\n\n**Spec gaps**\n- Picked 30s for the timeout\n- Named the export `foo`', ['Picked 30s for the timeout', 'Named the export `foo`']],
    ['Spec gaps: chose the error text myself', ['chose the error text myself']],
    ['## Spec gaps\n* a\n  continued\n* b\n\nQA verdict: PASS', ['a continued', 'b']],
    ['No report\n- a', []],
    ['Spec gaps: old\n---\nSpec gaps:\n- new\n- newest', ['new', 'newest']],
    ['Spec gaps: old\n---\nQA verdict: PASS', ['old']],
    ['Spec gaps:\n- old\n---\nSpec gaps: NONE.\n- ignored', []],
    ['', []],
  ];
  for (const [summary, expected] of examples) assert.deepEqual(parseSpecGaps(summary), expected, summary);
});

test('parseSpecGaps: Markdown marker variants and explicit empty reports override bullets', () => {
  for (const marker of ['Spec gaps:', '## sPeC gApS', '**Spec gaps**:', '**Spec gaps:**', '__Spec gaps__', '- **Spec gaps:**', '1. __Spec gaps:__', '**- Spec gaps**', '### **__Spec gaps__**']) {
    assert.deepEqual(parseSpecGaps(`${marker}\n- a\n+ b\n1. c`), ['a', 'b', 'c'], marker);
  }
  for (const none of ['none', 'NONE.', 'n/a', 'N/A.', 'nothing', 'Nothing.']) {
    assert.deepEqual(parseSpecGaps(`**Spec gaps: ${none}**\n- ignored`), []);
  }
  assert.deepEqual(parseSpecGaps('Spec gaps: chose **bold** and `some__name`'), ['chose **bold** and `some__name`']);
});

test('parseSpecGaps: continuation, blank-separated bullets, boundaries and item limits', () => {
  assert.deepEqual(parseSpecGaps('Spec gaps: inline loses to bullets\n\n- a\n  continued\n\n* b\n\twith   spaces\n# Heading\n- ignored'), ['a continued', 'b with spaces']);
  for (const boundary of ['\nQA verdict: PASS', '\n\n', '# Heading', '---', 'unindented text', '\n  indented after blank']) {
    assert.deepEqual(parseSpecGaps(`Spec gaps:\n- kept\n${boundary}\n- ignored`), ['kept']);
  }
  assert.deepEqual(parseSpecGaps('Spec gaps:\n-   \n- ok'), ['ok']);
  assert.deepEqual(parseSpecGaps(`Spec gaps:\n- ${'x'.repeat(301)}`), ['x'.repeat(299) + '…']);
  assert.deepEqual(parseSpecGaps(`Spec gaps: ${'x'.repeat(300)}`), ['x'.repeat(300)]);
});

const DAY = 86_400_000;
const NOW = 100 * DAY;
function task(id: string, at: number, summary = `Spec gaps: ${id}`, overrides: Partial<Task> = {}): Task {
  return { id, projectPath: '/project', title: `Title ${id}`, status: 'done', createdAt: at, summary, ...overrides };
}

test('recentSpecGaps: newest timestamp, summary order, age boundary, deleted and invalid tasks', () => {
  const tasks = [
    task('old', NOW - 61 * DAY),
    task('cutoff', NOW - 60 * DAY),
    task('new', NOW - DAY, 'Spec gaps:\n- first\n- second'),
    task('deleted', NOW + 1, undefined, { status: 'deleted' }),
    task('empty', NOW, ''),
    task('missing', NOW, undefined, { summary: undefined }),
    task('invalid', NaN, undefined, { doneAt: Infinity, updatedAt: -Infinity }),
    task('latest', 1, undefined, { doneAt: NOW - 5, mergedAt: NOW - 4, completedAt: NOW - 3, updatedAt: NOW - 2 }),
  ];
  assert.deepEqual(recentSpecGaps(tasks, { now: NOW }).map(({ taskId, gap, at }) => [taskId, gap, at]), [
    ['latest', 'latest', NOW - 2], ['new', 'first', NOW - DAY], ['new', 'second', NOW - DAY], ['cutoff', 'cutoff', NOW - 60 * DAY],
  ]);
  assert.equal(recentSpecGaps(tasks, { now: NOW, maxAgeDays: 0 }).length, 0);
});

test('recentSpecGaps: de-duplicate ignoring case, keep newest, enforce limits and defaults', () => {
  const tasks = [task('old', NOW - 1, 'Spec gaps: picked name'), task('new', NOW, 'Spec gaps:\n- PICKED NAME\n- other')];
  const gaps = recentSpecGaps(tasks, { now: NOW });
  assert.deepEqual(gaps.map(({ taskId, gap }) => [taskId, gap]), [['new', 'PICKED NAME'], ['new', 'other']]);
  assert.equal(recentSpecGaps(tasks, { now: NOW, limit: 1 }).length, 1);
  for (const limit of [0, -1]) assert.deepEqual(recentSpecGaps(tasks, { now: NOW, limit }), []);
  const many = Array.from({ length: 30 }, (_, i) => task(String(i), Date.now()));
  assert.equal(recentSpecGaps(many).length, 25);
});

test('renderTaskWritingGuidance: exact blocks, ordering, empty, caps and title truncation', () => {
  const gap: RecentSpecGap = { taskId: 't', title: 'Timeout', gap: 'Picked 30s', at: NOW };
  const rules = '**Rules for task descriptions in this project:**\n\n- Name exports\n- State errors\n\n';
  const reports = '**What implementers here recently had to decide themselves** (the task they ran did not say; state these kinds of decisions in the tasks you file):\n\n- Picked 30s (task "Timeout")\n\n';
  assert.equal(renderTaskWritingGuidance([], []), '');
  assert.equal(renderTaskWritingGuidance(['Name exports', 'State errors'], []), rules);
  assert.equal(renderTaskWritingGuidance([], [gap]), reports);
  assert.equal(renderTaskWritingGuidance(['Name exports', 'State errors'], [gap]), rules + reports);
  assert.match(renderTaskWritingGuidance(['Rule with trailing newlines\n\n'], []), /[^\n]\n\n$/);
  const many = Array.from({ length: 16 }, (_, i) => ({ ...gap, gap: `gap ${i}`, title: 't'.repeat(81) }));
  const rendered = renderTaskWritingGuidance([], many);
  assert.equal(rendered.match(/^- /gm)?.length, 15);
  assert.ok(rendered.includes(`(task "${'t'.repeat(79)}…")`));
  assert.ok(!rendered.includes('gap 15'));
  assert.match(rendered, /[^\n]\n\n$/);
});
