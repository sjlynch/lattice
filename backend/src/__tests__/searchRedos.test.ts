import { test } from 'node:test';
import assert from 'node:assert/strict';

// Force the JS grep fallback (no ripgrep) and give it a small wall-clock budget
// so the ReDoS containment is exercised quickly. Set before importing search so
// every call in this file (run in its own process by node:test) sees them.
process.env.LATTICE_DISABLE_RG = '1';
process.env.LATTICE_SEARCH_JS_BUDGET_MS = '500';

const { searchProjectContents } = await import('../search.js');
const { withTempDir, writeLayout } = await import('./helpers/tempDir.js');

// Regression: a user-supplied catastrophic-backtracking regex used to run
// `re.test` on the single-threaded event loop with no time bound — a pattern
// like `(?=(a+)+$)` against a file of many 'a's pinned V8 and froze the whole
// backend (and, because /api/search is a GET, a drive-by page could trigger it
// cross-origin). The JS fallback now runs in a worker thread the main process
// terminates on a budget, so the request returns in bounded time instead of
// hanging.
test('a catastrophic regex on the JS fallback returns within the budget, not hanging', async () => {
  await withTempDir('lattice-redos-', async (dir) => {
    // Many 'a's followed by a non-'a' char => `(a+)+$` can never match and
    // backtracks exponentially. Real backtracking is astronomically longer than
    // any budget; a `.ts` extension gets it collected by the source scanner.
    await writeLayout(dir, { 'redos.ts': 'a'.repeat(5000) + 'b' });

    const startedAt = Date.now();
    const result = await searchProjectContents(dir, {
      pattern: '(?=(a+)+$)',
      regex: true,
    });
    const elapsed = Date.now() - startedAt;

    // Budget is 500ms; allow generous slack for worker spin-up/terminate + CI
    // jitter, but it must be nowhere near "hangs forever".
    assert.ok(
      elapsed < 5000,
      `search should return in bounded time, took ${elapsed}ms`,
    );
    // Budget expiry surfaces as a truncated result rather than an error.
    assert.equal(result.truncated, true);
    assert.deepEqual(result.matches, []);
  });
});

// The worker path must still produce correct results for ordinary patterns.
test('the JS fallback worker returns correct matches for a benign regex', async () => {
  await withTempDir('lattice-search-ok-', async (dir) => {
    await writeLayout(dir, {
      'a.ts': 'const greeting = "hello world";\n',
      'b.ts': 'const n = 42;\n',
      'sub/c.ts': 'function hello() {}\n',
    });

    const hit = await searchProjectContents(dir, {
      pattern: 'hello',
      regex: true,
    });
    assert.equal(hit.truncated, false);
    assert.equal(hit.matches.length, 2);
    assert.ok(hit.matches.every((m) => m.endsWith('.ts')));
    assert.ok(hit.scanned >= 3);

    const miss = await searchProjectContents(dir, {
      pattern: 'nonexistent-token',
      regex: true,
    });
    assert.deepEqual(miss.matches, []);
    assert.equal(miss.truncated, false);
  });
});

// Wildcard (regex=0) queries flow through the same worker fallback.
test('the JS fallback worker honors wildcard (non-regex) queries', async () => {
  await withTempDir('lattice-search-wild-', async (dir) => {
    await writeLayout(dir, {
      'a.ts': 'hello there\n',
      'b.ts': 'goodbye\n',
    });
    const res = await searchProjectContents(dir, {
      pattern: 'hel*o',
      regex: false,
    });
    assert.equal(res.matches.length, 1);
    assert.ok(res.matches[0].endsWith('a.ts'));
  });
});

// An unparseable regex is still rejected up front (on the main thread) so the
// route can 400 it, rather than being handed to the worker.
test('an invalid regex still throws before the worker runs', async () => {
  await withTempDir('lattice-search-bad-', async (dir) => {
    await writeLayout(dir, { 'a.ts': 'x\n' });
    await assert.rejects(() =>
      searchProjectContents(dir, { pattern: '(', regex: true }),
    );
  });
});
