import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMENT_BY_EXT, stripStringsAndComments } from '../health/universal.js';

const TS_SYNTAX = COMMENT_BY_EXT['.ts'];

test('stripStringsAndComments ignores comment markers inside strings', () => {
  const source = [
    'const url = "https://example.test/a//b";',
    "const blockish = 'not /* a block */ still string';",
    'const after = 42;',
  ].join('\n');

  const stripped = stripStringsAndComments(source, TS_SYNTAX);
  const lines = stripped.split('\n');

  assert.equal(stripped.length, source.length);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].trim().endsWith(';'));
  assert.ok(lines[1].trim().endsWith(';'));
  assert.ok(stripped.includes('const after = 42;'));
  assert.equal(stripped.includes('https://example.test'), false);
  assert.equal(stripped.includes('not /* a block */'), false);
});

test('stripStringsAndComments removes block comments while preserving newlines', () => {
  const source = [
    'const before = 1;',
    '/*',
    'const hidden = 99;',
    '*/',
    'const after = 3;',
  ].join('\n');

  const stripped = stripStringsAndComments(source, TS_SYNTAX);

  assert.equal(stripped.length, source.length);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
  assert.ok(stripped.includes('const before = 1;'));
  assert.ok(stripped.includes('const after = 3;'));
  assert.equal(stripped.includes('const hidden = 99;'), false);
});
