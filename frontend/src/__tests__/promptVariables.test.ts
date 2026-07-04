import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowVariable } from '../api/index.ts';
import {
  USER_INSTRUCTIONS_VAR,
  VAR_TOKEN_RE,
  splitPromptSegments,
  withUserInstructions,
  ensureUserInstructions,
} from '../components/workflows/promptVariables.ts';

// These helpers are the frontend mirror of the backend interpolation grammar
// (backend/src/workflows/interpolate.ts `WORKFLOW_VARIABLE_PATTERN`). The
// editor highlight overlay uses `splitPromptSegments` to promise the user which
// `{{tokens}}` the backend will actually substitute — so the two grammars must
// agree, and the built-in `{{user_instructions}}` injection must land exactly
// once. These tests pin those invariants.

const defined = (...names: string[]): ReadonlySet<string> => new Set(names);

// --- splitPromptSegments ---------------------------------------------------

// The bug this guards: `VAR_TOKEN_RE` is a shared module-level `/g` regex, so
// its `lastIndex` is stateful. If a prior use (or a prior call) left it
// non-zero and the function failed to reset it, `exec` would start mid-string
// and miss a leading token — silently rendering `{{a}}` as plain text. The
// function resets `lastIndex = 0` up front; poison it here to prove that.
test('splitPromptSegments resets a poisoned VAR_TOKEN_RE.lastIndex', () => {
  VAR_TOKEN_RE.lastIndex = 5;
  const segments = splitPromptSegments('{{a}} rest', defined('a'));
  assert.deepEqual(segments, [
    { text: '{{a}}', token: true, name: 'a', known: true },
    { text: ' rest', token: false },
  ]);
  // …and it leaves the regex clean for the next consumer.
  assert.equal(VAR_TOKEN_RE.lastIndex, 0);
});

test('splitPromptSegments is idempotent across repeated calls', () => {
  const prompt = 'lead {{one}} mid {{two}} tail';
  const names = defined('one');
  const first = splitPromptSegments(prompt, names);
  const second = splitPromptSegments(prompt, names);
  assert.deepEqual(second, first);
  assert.deepEqual(first, [
    { text: 'lead ', token: false },
    { text: '{{one}}', token: true, name: 'one', known: true },
    { text: ' mid ', token: false },
    { text: '{{two}}', token: true, name: 'two', known: false },
    { text: ' tail', token: false },
  ]);
});

// Inner whitespace is outside the capture group in both grammars, so the
// captured name must be the trimmed identifier — and `known` keys off that
// trimmed name, not the raw `{{ scope }}` bytes.
test('splitPromptSegments captures the trimmed name for inner-whitespace tokens', () => {
  const known = splitPromptSegments('{{ scope }}', defined('scope'));
  assert.deepEqual(known, [
    { text: '{{ scope }}', token: true, name: 'scope', known: true },
  ]);

  const unknown = splitPromptSegments('{{ scope }}', defined('other'));
  assert.deepEqual(unknown, [
    { text: '{{ scope }}', token: true, name: 'scope', known: false },
  ]);
});

// Token-looking text that violates the identifier grammar (hyphen, interior
// space, empty braces) must NOT be treated as a variable — otherwise the
// overlay would promise a substitution the backend never performs.
test('splitPromptSegments leaves invalid token-looking text as plain text', () => {
  for (const bad of ['{{foo-bar}}', '{{ has space }}', '{{}}', '{{ }}', '{ {solo} }']) {
    assert.deepEqual(
      splitPromptSegments(bad, defined('foo', 'bar', 'has', 'space')),
      [{ text: bad, token: false }],
      `expected ${bad} to stay plain text`,
    );
  }
});

test('splitPromptSegments keeps a bad token between two good ones plain', () => {
  const segments = splitPromptSegments('{{a}} {{b-c}} {{d}}', defined('a', 'd'));
  assert.deepEqual(segments, [
    { text: '{{a}}', token: true, name: 'a', known: true },
    { text: ' {{b-c}} ', token: false },
    { text: '{{d}}', token: true, name: 'd', known: true },
  ]);
});

test('splitPromptSegments returns a single plain segment for token-free text', () => {
  assert.deepEqual(splitPromptSegments('just words', defined()), [
    { text: 'just words', token: false },
  ]);
});

test('splitPromptSegments returns no segments for an empty prompt', () => {
  assert.deepEqual(splitPromptSegments('', defined('a')), []);
});

// --- withUserInstructions --------------------------------------------------

const TOKEN = `{{${USER_INSTRUCTIONS_VAR}}}`;

test('withUserInstructions appends the token beneath a trimmed prompt', () => {
  assert.equal(withUserInstructions('Do the thing'), `Do the thing\n\n${TOKEN}`);
});

// Trailing whitespace is stripped before the token is appended so the built-in
// prompts don't accumulate blank lines each time this is applied.
test('withUserInstructions trims trailing whitespace before appending', () => {
  assert.equal(
    withUserInstructions('Do the thing\n\n  \t'),
    `Do the thing\n\n${TOKEN}`,
  );
});

test('withUserInstructions returns just the token for a blank prompt', () => {
  assert.equal(withUserInstructions(''), TOKEN);
  assert.equal(withUserInstructions('   \n\t '), TOKEN);
});

// The core "exactly once" invariant: a prompt already referencing the token is
// returned untouched, and applying the helper twice is a no-op the second time.
test('withUserInstructions appends the token exactly once (idempotent)', () => {
  const already = `Step body\n\n${TOKEN}`;
  assert.equal(withUserInstructions(already), already);

  const once = withUserInstructions('Step body');
  assert.equal(withUserInstructions(once), once);
  // The token appears a single time even after a second application.
  assert.equal(once.split(TOKEN).length - 1, 1);
});

test('withUserInstructions matches an existing token anywhere in the prompt', () => {
  const inline = `Use ${TOKEN} as context, then continue.`;
  assert.equal(withUserInstructions(inline), inline);
});

// --- ensureUserInstructions ------------------------------------------------

const vv = (name: string): WorkflowVariable => ({ id: `id_${name}`, name, value: '' });

test('ensureUserInstructions prepends the built-in variable when absent', () => {
  const result = ensureUserInstructions([vv('foo'), vv('bar')]);
  assert.deepEqual(
    result.map((v) => v.name),
    [USER_INSTRUCTIONS_VAR, 'foo', 'bar'],
  );
  // The injected variable starts empty (a no-op substitution) and has an id.
  assert.equal(result[0].value, '');
  assert.ok(result[0].id);
});

test('ensureUserInstructions injects into an empty list', () => {
  const result = ensureUserInstructions([]);
  assert.deepEqual(
    result.map((v) => v.name),
    [USER_INSTRUCTIONS_VAR],
  );
});

// The bug this guards: re-injecting would duplicate the built-in, and eagerly
// moving it to the front would reorder the user's variables for no reason.
// When the variable is already present the input array is returned verbatim.
test('ensureUserInstructions never duplicates or reorders an existing built-in', () => {
  const input = [vv('foo'), vv(USER_INSTRUCTIONS_VAR), vv('bar')];
  const result = ensureUserInstructions(input);
  // Same reference back — no copy, no reshuffle.
  assert.equal(result, input);
  assert.deepEqual(
    result.map((v) => v.name),
    ['foo', USER_INSTRUCTIONS_VAR, 'bar'],
  );
  assert.equal(
    result.filter((v) => v.name === USER_INSTRUCTIONS_VAR).length,
    1,
  );
});

test('ensureUserInstructions leaves a lone built-in untouched', () => {
  const input = [vv(USER_INSTRUCTIONS_VAR)];
  assert.equal(ensureUserInstructions(input), input);
});
