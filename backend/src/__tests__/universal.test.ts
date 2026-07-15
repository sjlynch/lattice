import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENT_BY_EXT,
  countLineKinds,
  countUniversalSmells,
  stripStringsAndComments,
} from '../health/universal.js';

const TS_SYNTAX = COMMENT_BY_EXT['.ts'];

function smell(content: string, id: string): number {
  return countUniversalSmells(content, TS_SYNTAX).get(id as never) ?? 0;
}

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

test('stripStringsAndComments blanks regex literals so their digits do not count', () => {
  const source = 'if (/[0-9]{3}/.test(x)) y = 55;';
  const stripped = stripStringsAndComments(source, TS_SYNTAX);
  assert.equal(stripped.length, source.length);
  // The regex body (incl. 0/9/3) is gone; only the real assignment remains.
  assert.equal(stripped.includes('[0-9]'), false);
  assert.ok(stripped.includes('y = 55;'));
});

test('stripStringsAndComments keeps code inside ${...} interpolations', () => {
  const source = 'const x = `value ${42} here`;';
  const stripped = stripStringsAndComments(source, TS_SYNTAX);
  assert.equal(stripped.length, source.length);
  // The literal template text is blanked but the interpolated expression
  // (with its magic number) survives.
  assert.equal(stripped.includes('value'), false);
  assert.equal(stripped.includes('here'), false);
  assert.ok(stripped.includes('42'));
});

test('stripStringsAndComments blanks strings and comments inside interpolations', () => {
  const source = 'const x = `value ${"ignored }" /* hidden 99 */ + 7} here`;';
  const stripped = stripStringsAndComments(source, TS_SYNTAX);
  assert.equal(stripped.length, source.length);
  assert.equal(stripped.includes('ignored'), false);
  assert.equal(stripped.includes('hidden 99'), false);
  assert.ok(stripped.includes('+ 7'));
});

test('regex disambiguation does not let a JSX close tag swallow later code', () => {
  // Without treating `<`/`>` as value-enders the `/` in `</a>` scanned ahead
  // to the division `/` and blanked the `6` in between.
  const source = 'const el = <a></a>; const r = 6 / 2;';
  const stripped = stripStringsAndComments(source, TS_SYNTAX);
  assert.ok(stripped.includes('6'), stripped);
  assert.ok(stripped.includes('2'));
});

test('strings-kept view retains string literals but drops comments', () => {
  const source = ['// "commented out"', 'const real = "kept";'].join('\n');
  const stripped = stripStringsAndComments(source, TS_SYNTAX, { strings: false });
  assert.equal(stripped.includes('commented out'), false);
  assert.ok(stripped.includes('"kept"'));
});

test('comments-kept view retains comments but drops string data', () => {
  const source = ['// TODO real', 'const label = "TODO data";'].join('\n');
  const stripped = stripStringsAndComments(source, TS_SYNTAX, { comments: false });
  assert.ok(stripped.includes('TODO real'));
  assert.equal(stripped.includes('TODO data'), false);
});

test('magic_number ignores regex digits but counts real literals', () => {
  // Pre-fix the regex left 0/9/3 visible, yielding magic_number=3.
  assert.equal(smell('if (/[0-9]{3}/.test(x)) y = 55;', 'magic_number'), 1);
});

test('magic_number counts numbers inside template interpolations', () => {
  // Pre-fix the whole `${42}` was blanked, yielding magic_number=0.
  assert.equal(smell('const x = `value ${42} here`;', 'magic_number'), 1);
});

test('todo_fixme counts markers in comments but not in string data', () => {
  const source = ['// TODO: a real marker', 'const label = "TODO list app";'].join('\n');
  // The comment marker counts; the one embedded in string data does not.
  assert.equal(smell(source, 'todo_fixme'), 1);
});

test('long_string_literal ignores long runs inside comments', () => {
  const longRun = 'x'.repeat(220);
  const source = [
    `// note: "${longRun}"`,
    `const real = "${'y'.repeat(220)}";`,
  ].join('\n');
  // Only the genuine string literal counts, not the quoted run in the comment.
  assert.equal(smell(source, 'long_string_literal'), 1);
});

// ReDoS containment. The universal smell regexes run on the main thread over
// every scanned file, so a single catastrophic-backtracking input freezes the
// whole backend event loop (the frontend hangs on "scanning"). LONG_STRING_RE
// was the concrete offender: an opening quote followed by a long backslash run
// with no closing quote tiled the run in exponentially many ways and pinned a
// CPU core for minutes. This battery feeds each known pathological SHAPE through
// the real countUniversalSmells entry point and asserts the whole pass stays
// near-linear. If anyone re-introduces an ambiguous quantifier in ANY of these
// regexes, this test fails in milliseconds instead of wedging a scan in prod.
test('countUniversalSmells stays linear on adversarial inputs (ReDoS guard)', () => {
  const bs = String.fromCharCode(92);
  const q = '"';
  const cases: Array<[string, string]> = [
    // Opening quote + long pure-backslash run, no closing quote.
    ['unterminated backslash run', `const q = ${q}${bs.repeat(2000)}`],
    // Opening quote + Windows-path-like run (\a\a\a…), no closing quote — the
    // exact shape from the original bug report.
    ['unterminated windows path', `const p = ${q}C:${(bs + 'a').repeat(2000)}`],
    // Opening quote + long plain run, no closing quote.
    ['unterminated plain run', `const s = ${q}${'a'.repeat(5000)}`],
    // Backslash run that DOES close — the match must still be cheap to find.
    ['terminated backslash run', `const s = ${q}${bs.repeat(2000)}x${q};`],
    // Many escaped quotes in one line (each \" could be mis-tiled).
    ['escaped-quote storm', `const s = ${q}${(bs + q).repeat(2000)}`],
  ];

  const start = process.hrtime.bigint();
  for (const [, content] of cases) {
    // We only care that it RETURNS (doesn't hang); the exact counts are covered
    // by the dedicated tests above/below.
    countUniversalSmells(content, TS_SYNTAX);
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // A linear pass over ~11k chars ×5 is sub-millisecond; the old regex took
  // minutes on a single case. 500ms is a generous ceiling that still catches
  // any exponential-blowup regression unambiguously.
  assert.ok(ms < 500, `countUniversalSmells should stay linear, took ${ms.toFixed(1)}ms`);
});

test('long_string_literal still counts terminated strings with many escapes', () => {
  // A properly closed string full of escape sequences must still be detected —
  // the ReDoS fix must not drop genuine long literals.
  const source = `const s = "${('ab' + String.fromCharCode(92) + 'n').repeat(100)}";`;
  assert.equal(smell(source, 'long_string_literal'), 1);
});

test('countLineKinds counts code that follows a mid-line block-comment close', () => {
  const source = ['/* doc', ' end */ doStuff();'].join('\n');
  const counts = countLineKinds(source, TS_SYNTAX);
  assert.equal(counts.total, 2);
  assert.equal(counts.comment, 1);
  assert.equal(counts.code, 1);
  assert.equal(counts.blank, 0);
});

test('countLineKinds treats a trailing block comment after code as code', () => {
  const source = 'doStuff(); /* trailing note */';
  const counts = countLineKinds(source, TS_SYNTAX);
  assert.equal(counts.code, 1);
  assert.equal(counts.comment, 0);
});
