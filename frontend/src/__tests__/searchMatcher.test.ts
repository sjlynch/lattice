import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchRegExp } from '../components/forceGraph/searchMatcher.ts';

// buildSearchRegExp builds the graph search bar's filename matcher. It MUST stay
// in sync with the backend buildSearchRegExp (backend/src/search.ts) so a
// wildcard query selects the same files whether the hit came from a filename
// match (this) or a file-contents match (backend). It must also return null
// (never throw) on empty/invalid input so the UI can show an inline error.

test('empty pattern returns null in both modes', () => {
  assert.equal(buildSearchRegExp('', false), null);
  assert.equal(buildSearchRegExp('', true), null);
});

test('regex mode compiles a valid pattern with the case-insensitive flag', () => {
  const re = buildSearchRegExp('foo.*bar', true);
  assert.ok(re instanceof RegExp);
  assert.equal(re!.flags, 'i');
  // Case-insensitive, and `.*` spans arbitrary text between foo and bar.
  assert.ok(re!.test('xxFOObazBARyy'));
  assert.ok(!re!.test('foobaz')); // no 'bar' → no match
});

test('regex mode returns null (never throws) on an invalid pattern', () => {
  // '*[' → nothing-to-repeat plus an unterminated character class.
  assert.equal(buildSearchRegExp('*[', true), null);
  // '(' → unterminated group.
  assert.equal(buildSearchRegExp('(', true), null);
});

test('wildcard mode translates * to any run and matches unanchored', () => {
  const re = buildSearchRegExp('*.ts', false);
  assert.ok(re instanceof RegExp);
  assert.equal(re!.flags, 'i');
  assert.ok(re!.test('foo.ts'));
  assert.ok(re!.test('a/b.ts')); // unanchored: matches the tail of a path
  // The '.' is a literal separator, not the regex any-char, so 'fooXts'
  // (no literal dot before 'ts') does NOT match.
  assert.ok(!re!.test('fooXts'));
});

test('wildcard mode translates ? to exactly one character', () => {
  const re = buildSearchRegExp('??.py', false);
  assert.ok(re!.test('ab.py')); // two chars then '.py'
  assert.ok(!re!.test('a.py')); // only one char before '.py'
  assert.ok(!re!.test('abc')); // no '.py' at all
});

test('wildcard mode treats a bare pattern as an unanchored substring match', () => {
  const re = buildSearchRegExp('abc', false);
  assert.ok(re!.test('xabcy')); // substring
  assert.ok(re!.test('ABC')); // case-insensitive
  assert.ok(!re!.test('abd'));
});

test('wildcard mode escapes regex metacharacters to literals', () => {
  // A dot is literal: 'a.b' matches 'a.b' but not 'axb'.
  const dot = buildSearchRegExp('a.b', false);
  assert.ok(dot!.test('a.b'));
  assert.ok(!dot!.test('axb'));

  // A plus is literal, not a quantifier: 'a+b' matches 'a+b' but not 'aaab'.
  const plus = buildSearchRegExp('a+b', false);
  assert.ok(plus!.test('a+b'));
  assert.ok(!plus!.test('aaab'));

  // dot, plus, parens, brackets, braces, caret, dollar, and pipe are all
  // literal in wildcard mode, so a pattern full of them matches itself.
  const literal = 'a.b+c^d$e(f)g{h}i|j[k]';
  const re = buildSearchRegExp(literal, false);
  assert.ok(re!.test(literal));
});

test('wildcard mode is case-insensitive', () => {
  const re = buildSearchRegExp('README', false);
  assert.ok(re!.test('readme'));
});
