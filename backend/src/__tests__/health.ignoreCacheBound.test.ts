// `ignore` memoizes every path it has been asked about (plus parent prefixes)
// and only resets that cache when rules are added. The health / git-status
// watchers keep one matcher per project for the process lifetime and feed it
// every unique path an fs event names, so `matchIgnoredSourcePath` re-inits the
// cache every IGNORE_CACHE_RESET_LOOKUPS lookups. Pins that the cache stays
// bounded and that matching is unaffected by a reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ignore from 'ignore';
import { matchIgnoredSourcePath } from '../health/constants.js';

test('matchIgnoredSourcePath keeps the ignore cache bounded without changing results', () => {
  const root = path.resolve('/proj');
  const ig = ignore().add('dist/\n*.log');
  for (let i = 0; i < 50_000; i++) {
    matchIgnoredSourcePath(path.join(root, 'src', `f${i}.ts`), root, ig);
  }
  const cached = Object.keys((ig as unknown as { _ignoreCache: object })._ignoreCache).length;
  assert.ok(cached <= 20_000 + 10, `cache holds ${cached} entries after 50k unique lookups`);
  assert.equal(matchIgnoredSourcePath(path.join(root, 'dist', 'a.js'), root, ig), true);
  assert.equal(matchIgnoredSourcePath(path.join(root, 'x.log'), root, ig), true);
  assert.equal(matchIgnoredSourcePath(path.join(root, 'src', 'a.ts'), root, ig), false);
});
