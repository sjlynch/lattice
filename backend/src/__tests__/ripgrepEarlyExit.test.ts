import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { searchWithRipgrep } from '../ripgrep.js';
import { withTempDir } from './helpers/tempDir.js';

// End-to-end proof that `searchWithRipgrep` terminates rg EARLY once it has
// enough paths, instead of buffering the whole repo's matches. The fake rg
// below streams NUL-delimited paths *forever* (respecting backpressure). The
// old buffer-everything implementation would `Buffer.concat` at close and never
// resolve on such a stream — this test would hang and hit its timeout. The
// fixed implementation collects `limit` + 1, kills the child, and resolves
// quickly with exactly `limit` matches and `truncated: true`.
//
// `searchWithRipgrep` spawns rg WITHOUT a shell; Node ≥ 18.20/20.12/21.7 refuses
// to spawn a `.cmd`/`.bat` without one, and a bare `.js` isn't directly
// executable on Windows, so the spawnable fake here is a POSIX shebang launcher.
// The parsing/truncation logic itself is covered cross-platform (incl. Windows)
// by ripgrepCollector.test.ts.
const skip = process.platform === 'win32' ? 'needs a POSIX-executable fake rg' : false;

// A fake rg that ignores its args and emits an unbounded stream of
// `file_<n>.ts\0` paths, pumping on `drain` so it honours backpressure (and so
// it dies promptly when the parent kills it rather than spinning a tight loop).
const FAKE_RG_BODY = `
let i = 0;
function pump() {
  let ok = true;
  while (ok) ok = process.stdout.write('file_' + (i++) + '.ts\\0');
  process.stdout.once('drain', pump);
}
process.stdout.on('error', () => process.exit(0)); // EPIPE when the pipe closes
pump();
`;

async function writeFakeRg(dir: string): Promise<string> {
  const emitter = path.join(dir, 'fake-rg.cjs');
  await fs.writeFile(emitter, FAKE_RG_BODY, 'utf8');
  // A tiny /bin/sh launcher so the fixed args searchWithRipgrep appends are
  // harmlessly forwarded (and ignored) while node runs the emitter.
  const launcher = path.join(dir, 'fake-rg');
  await fs.writeFile(
    launcher,
    `#!/bin/sh\nexec "${process.execPath}" "${emitter}" "$@"\n`,
    'utf8',
  );
  await fs.chmod(launcher, 0o755);
  return launcher;
}

test(
  'searchWithRipgrep kills rg early on an unbounded match stream',
  { skip, timeout: 15_000 },
  async () => {
    await withTempDir('lattice-rg-early-', async (dir) => {
      const rg = await writeFakeRg(dir);
      const startedAt = Date.now();
      const { matches, truncated } = await searchWithRipgrep(rg, dir, {
        regexSource: 'anything',
        limit: 5,
        maxFileBytes: 2 * 1024 * 1024,
      });
      const elapsed = Date.now() - startedAt;

      // Capped at `limit` and flagged truncated, without draining the infinite
      // stream (which is only possible because we killed the child early).
      assert.equal(matches.length, 5);
      assert.equal(truncated, true);
      assert.ok(
        matches.every((m) => m.endsWith('.ts')),
        `matches should be resolved paths, got ${JSON.stringify(matches)}`,
      );
      // Should return near-instantly; the generous bound only guards against a
      // regression that reintroduces buffer-until-close (which would time out).
      assert.ok(elapsed < 10_000, `expected an early exit, took ${elapsed}ms`);
    });
  },
);

// Sanity: a bounded stream shorter than `limit` returns everything, untruncated
// — the early-exit path must not over-trigger.
test(
  'searchWithRipgrep returns all matches when rg emits fewer than `limit`',
  { skip, timeout: 15_000 },
  async () => {
    await withTempDir('lattice-rg-few-', async (dir) => {
      const emitter = path.join(dir, 'fake-rg.cjs');
      await fs.writeFile(
        emitter,
        `process.stdout.write('a.ts\\0b.ts\\0c.ts\\0');\n`,
        'utf8',
      );
      const launcher = path.join(dir, 'fake-rg');
      await fs.writeFile(
        launcher,
        `#!/bin/sh\nexec "${process.execPath}" "${emitter}" "$@"\n`,
        'utf8',
      );
      await fs.chmod(launcher, 0o755);

      const { matches, truncated } = await searchWithRipgrep(launcher, dir, {
        regexSource: 'anything',
        limit: 10,
        maxFileBytes: 2 * 1024 * 1024,
      });
      assert.equal(truncated, false);
      assert.deepEqual(
        matches.map((m) => path.basename(m)),
        ['a.ts', 'b.ts', 'c.ts'],
      );
    });
  },
);
