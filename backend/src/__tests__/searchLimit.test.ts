import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimitParam } from '../routes/search.js';

// Regression: `?limit=1.5` (and other fractional/garbage values) used to pass
// `Number(req.query.limit) || undefined`'s `>0` truthiness check and reach
// ripgrep / the JS grep as a non-integer cap — erroring rg (forcing the slow JS
// fallback on every keystroke) and giving the two code paths inconsistent
// cutoffs. The query param must coerce to a positive integer or be ignored.
test('parseLimitParam floors a fractional limit to a positive integer', () => {
  assert.equal(parseLimitParam('1.5'), 1);
  assert.equal(parseLimitParam('2.9'), 2);
  assert.equal(parseLimitParam('10'), 10);
});

test('parseLimitParam ignores zero, negative, and non-numeric limits', () => {
  // undefined → search.ts applies its own DEFAULT_LIMIT.
  assert.equal(parseLimitParam('0'), undefined);
  assert.equal(parseLimitParam('0.4'), undefined); // floors to 0 → ignored
  assert.equal(parseLimitParam('-3'), undefined);
  assert.equal(parseLimitParam('abc'), undefined);
  assert.equal(parseLimitParam(''), undefined);
  assert.equal(parseLimitParam('Infinity'), undefined);
  assert.equal(parseLimitParam(undefined), undefined);
  // Repeated query params arrive as an array; non-coercible → ignored.
  assert.equal(parseLimitParam(['1', '2']), undefined);
});
