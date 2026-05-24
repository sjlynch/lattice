import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdownDoc,
  parseMarkdownTasks,
  serializeTasksAsMarkdown,
} from '../routes/tasks/markdownBatch.js';

test('parseMarkdownTasks: top-level headings create tasks', () => {
  assert.deepEqual(parseMarkdownTasks('# First\nBody\n# Second\nMore'), [
    { title: 'First', description: 'Body' },
    { title: 'Second', description: 'More' },
  ]);
});

test('parseMarkdownTasks: discards preamble before the first heading', () => {
  assert.deepEqual(parseMarkdownTasks('intro\n\nstill intro\n# Task\nBody'), [
    { title: 'Task', description: 'Body' },
  ]);
});

test('parseMarkdownTasks: omits blank descriptions', () => {
  assert.deepEqual(parseMarkdownTasks('# Title only\n\n\n# Also blank\n   '), [
    { title: 'Title only' },
    { title: 'Also blank' },
  ]);
});

test('parseMarkdownTasks: preserves multi-line descriptions', () => {
  assert.deepEqual(parseMarkdownTasks('# Task\nline one\nline two\n\nline four'), [
    { title: 'Task', description: 'line one\nline two\n\nline four' },
  ]);
});

test('parseMarkdownDoc: extracts id + status from heading metadata block', () => {
  const doc = parseMarkdownDoc('# {id=t_abc, status=open} Title\nBody');
  assert.deepEqual(doc.tasks, [
    { id: 't_abc', status: 'open', title: 'Title', description: 'Body' },
  ]);
});

test('parseMarkdownDoc: metadata block supports whitespace separator', () => {
  const doc = parseMarkdownDoc('# {id=t_abc status=qa} Title');
  assert.deepEqual(doc.tasks, [{ id: 't_abc', status: 'qa', title: 'Title' }]);
});

test('parseMarkdownDoc: heading without metadata is a plain task', () => {
  const doc = parseMarkdownDoc('# Brand new task\nDetails');
  assert.deepEqual(doc.tasks, [{ title: 'Brand new task', description: 'Details' }]);
});

test('parseMarkdownDoc: frontmatter project + hash are extracted', () => {
  const doc = parseMarkdownDoc(
    '<!-- lattice: project=C:/dev/foo, hash=abc123 -->\n# Title',
  );
  assert.equal(doc.project, 'C:/dev/foo');
  assert.equal(doc.hash, 'abc123');
  assert.deepEqual(doc.tasks, [{ title: 'Title' }]);
});

test('parseMarkdownDoc: subheadings stay in description body', () => {
  const doc = parseMarkdownDoc('# Task\n## Subhead\nBody\n### Deeper');
  assert.deepEqual(doc.tasks, [
    { title: 'Task', description: '## Subhead\nBody\n### Deeper' },
  ]);
});

test('parseMarkdownDoc: # inside fenced code is body, not a heading', () => {
  const doc = parseMarkdownDoc('# Task\nIntro\n```\n# fake heading\nmore\n```\nafter');
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].title, 'Task');
  assert.match(doc.tasks[0].description!, /# fake heading/);
  assert.match(doc.tasks[0].description!, /after$/);
});

test('serializeTasksAsMarkdown: emits frontmatter + round-trippable heading', () => {
  const md = serializeTasksAsMarkdown(
    [
      { id: 't_one', title: 'First', description: 'body', status: 'open' },
      { id: 't_two', title: 'Second', status: 'qa' },
    ],
    { canonicalProject: 'C:/dev/foo', hash: 'abc123', statusFilter: 'open,qa' },
  );
  assert.match(md, /<!-- lattice: project=C:\/dev\/foo, hash=abc123, status=open,qa -->/);
  assert.match(md, /^# \{id=t_one, status=open\} First$/m);
  assert.match(md, /^# \{id=t_two, status=qa\} Second$/m);

  // Round-trip: serialize → parse → same data
  const doc = parseMarkdownDoc(md);
  assert.equal(doc.project, 'C:/dev/foo');
  assert.equal(doc.hash, 'abc123');
  assert.deepEqual(doc.tasks, [
    { id: 't_one', status: 'open', title: 'First', description: 'body' },
    { id: 't_two', status: 'qa', title: 'Second' },
  ]);
});

test('serializeTasksAsMarkdown: empty list still emits frontmatter', () => {
  const md = serializeTasksAsMarkdown([], { canonicalProject: 'X', hash: 'h' });
  assert.match(md, /<!-- lattice: project=X, hash=h -->/);
  assert.match(md, /<!-- no tasks -->/);
});
