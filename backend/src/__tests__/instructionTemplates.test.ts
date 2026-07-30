import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTemplate,
  TEMPLATE_TOKEN_RE,
} from '../instructionTemplates/apply.js';

// applyTemplate is the ONE substitution engine behind every agent brief
// Lattice writes (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md, the QA / push /
// post-merge / workflow-step files). A regression here silently mangles or
// blanks instructions across the whole task/workflow pipeline, so the two
// load-bearing invariants are pinned first: an unknown token stays VERBATIM,
// and replacement text is NEVER re-scanned.

test('applyTemplate: an unknown token is left verbatim', () => {
  // A typo in a user-edited template stays visible instead of blanking the
  // section it was meant to fill.
  assert.equal(applyTemplate('{{a}} {{unknown}}', { a: 'x' }), 'x {{unknown}}');
  assert.equal(applyTemplate('{{nope}}', {}), '{{nope}}');
});

test('applyTemplate: replacement text is not re-scanned', () => {
  // A value that itself contains {{var}} — e.g. a workflow step prompt with an
  // unresolved variable — survives intact rather than being recursively
  // expanded (or used to inject another token).
  assert.equal(applyTemplate('{{a}}', { a: '{{b}}' }), '{{b}}');
  // Even when the injected token IS a known key, it is not expanded.
  assert.equal(applyTemplate('{{a}}', { a: '{{b}}', b: 'BOOM' }), '{{b}}');
  // ...and a value that reproduces its own token doesn't loop.
  assert.equal(applyTemplate('{{a}}', { a: '{{a}}' }), '{{a}}');
});

test('applyTemplate: tolerates whitespace inside the braces', () => {
  assert.equal(applyTemplate('{{ token }}', { token: 'v' }), 'v');
  assert.equal(applyTemplate('{{token }}', { token: 'v' }), 'v');
  assert.equal(applyTemplate('{{  token  }}', { token: 'v' }), 'v');
  // Whitespace-tolerant matching applies to the unknown case too.
  assert.equal(applyTemplate('{{ nope }}', {}), '{{ nope }}');
});

test('applyTemplate: substitutes repeated and multiple tokens in one pass', () => {
  assert.equal(applyTemplate('{{a}}-{{a}}-{{a}}', { a: '1' }), '1-1-1');
  assert.equal(
    applyTemplate('# {{title}}\n\nid: {{id}} ({{title}})', {
      title: 'Fix it',
      id: 't_1',
    }),
    '# Fix it\n\nid: t_1 (Fix it)',
  );
  // Mixed known + unknown in one template: the known ones still land.
  assert.equal(
    applyTemplate('{{a}} {{missing}} {{b}}', { a: 'A', b: 'B' }),
    'A {{missing}} B',
  );
});

test('applyTemplate: an empty-string value renders as empty, not verbatim', () => {
  // Conditional/computed blocks (autonomy preamble, env notes, dead-code note)
  // are passed as '' when absent — they must vanish, not leak their token.
  assert.equal(applyTemplate('a{{block}}b', { block: '' }), 'ab');
  assert.equal(
    applyTemplate('head\n{{env_notes}}\ntail', { env_notes: '' }),
    'head\n\ntail',
  );
});

test('applyTemplate: `$` sequences in a value are inserted literally', () => {
  // The replacer is a function, so String.replace does NOT interpret $&/$1/$$
  // in the value — a task description containing them survives byte-for-byte.
  assert.equal(applyTemplate('{{a}}', { a: '$& $1 $$ $`' }), '$& $1 $$ $`');
});

test('applyTemplate: inherited Object.prototype keys are not treated as values', () => {
  // hasOwnProperty guard: `{{toString}}` must not render a function body.
  assert.equal(applyTemplate('{{toString}}', {}), '{{toString}}');
  assert.equal(applyTemplate('{{constructor}}', {}), '{{constructor}}');
});

test('applyTemplate: non-token brace shapes are left alone', () => {
  assert.equal(applyTemplate('{single}', { single: 'v' }), '{single}');
  assert.equal(applyTemplate('{{}}', {}), '{{}}');
  // The token charset is [A-Za-z0-9_] only — a dotted/dashed name never matches.
  assert.equal(applyTemplate('{{a.b}}', { 'a.b': 'v' }), '{{a.b}}');
  assert.equal(applyTemplate('{{a-b}}', { 'a-b': 'v' }), '{{a-b}}');
});

test('applyTemplate: repeated calls are independent (shared /g regex lastIndex)', () => {
  // TEMPLATE_TOKEN_RE is a module-level global regex shared by every render;
  // a leaked lastIndex would make the second brief drop its first token.
  const values = { a: 'A', b: 'B' };
  const first = applyTemplate('{{a}} {{b}}', values);
  const second = applyTemplate('{{a}} {{b}}', values);
  assert.equal(first, 'A B');
  assert.equal(second, first);
  assert.equal(TEMPLATE_TOKEN_RE.lastIndex, 0);
});
