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

// ----------------------------------------------------- round-trip escaping --
// GET ?format=markdown → POST /upsert unchanged must be a no-op. A description
// line that reads as structure used to split the task (`# Plan` became a NEW
// task) or, for an unclosed fence, fold every later task into this one.

function roundTrip(tasks: Array<{ id: string; title: string; status: string; description?: string }>) {
  return parseMarkdownDoc(serializeTasksAsMarkdown(tasks, { canonicalProject: 'C:/p', hash: 'h' }));
}

test('round-trip: a level-1 heading inside a description stays in that description', () => {
  const description = 'Intro\n\n# Plan\nx';
  const doc = parseMarkdownDoc(
    serializeTasksAsMarkdown([{ id: 't_a', title: 'T', status: 'open', description }]),
  );
  assert.deepEqual(doc.tasks, [{ id: 't_a', status: 'open', title: 'T', description }]);
});

test('round-trip: a description with an unclosed fence is preserved', () => {
  const description = 'Intro\n```js\nconst x = 1;\n# not a heading';
  const doc = roundTrip([{ id: 't_a', title: 'T', status: 'open', description }]);
  assert.deepEqual(doc.tasks, [{ id: 't_a', status: 'open', title: 'T', description }]);
});

test('round-trip: an unclosed fence in the first task does not swallow the second', () => {
  const tasks = [
    { id: 't_a', title: 'A', status: 'open', description: 'see:\n~~~\n# still A' },
    { id: 't_b', title: 'B', status: 'qa', description: 'body of B\n# Section\nmore' },
  ];
  const doc = roundTrip(tasks);
  assert.deepEqual(
    doc.tasks,
    tasks.map((t) => ({ id: t.id, status: t.status, title: t.title, description: t.description })),
  );
});

test('round-trip: balanced fences stay raw and their contents untouched', () => {
  const description = 'Run:\n```bash\n# install\n\\# literal\nnpm i\n```\nafter\n# Heading';
  const md = serializeTasksAsMarkdown([{ id: 't_a', title: 'T', status: 'open', description }]);
  assert.match(md, /^```bash$/m);
  assert.match(md, /^# install$/m, 'lines inside a closed fence are not escaped');
  assert.match(md, /^\\# literal$/m, 'a backslash inside a closed fence is untouched');
  assert.match(md, /^\\# Heading$/m, 'a heading outside a fence is escaped');
  assert.deepEqual(parseMarkdownDoc(md).tasks[0].description, description);
});

test('round-trip: lines that already start with backslashes survive exactly', () => {
  const description = 'a\n\\# one\n\\\\# two\n\\```\nz';
  const doc = roundTrip([{ id: 't_a', title: 'T', status: 'open', description }]);
  assert.equal(doc.tasks[0].description, description);
});

test('serializeTasksAsMarkdown: a truncated listing says so in-band, and the parser ignores it', () => {
  const md = serializeTasksAsMarkdown([{ id: 't_a', title: 'T', status: 'open' }], {
    canonicalProject: 'C:/p',
    hash: 'h',
    truncated: { shown: 1, matched: 3 },
  });
  assert.match(md, /<!-- lattice: project=C:\/p, hash=h, truncated=1\/3 -->/);
  assert.match(md, /<!-- showing 1 of 3 matching tasks .*limit=0/);
  const doc = parseMarkdownDoc(md);
  assert.equal(doc.project, 'C:/p');
  assert.deepEqual(doc.tasks, [{ id: 't_a', status: 'open', title: 'T' }]);
});
