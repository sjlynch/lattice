import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownTasks } from '../routes/tasks/markdownBatch.js';

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
