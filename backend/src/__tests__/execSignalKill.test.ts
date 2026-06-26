import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from '../worktree/exec.js';
import { countBetween } from '../worktree/state.js';
import { withTempDir } from './helpers/tempDir.js';

// Regression for: a signal-killed git process was reported as exit 0, so
// countBetween read `git rev-list --count` as 0 commits and a task could be
// finalized to QA without merging its commits (silent data loss). See
// worktree/exec.ts 'close' handler + worktree/state.ts countBetween.

test('exec reports a signal-killed process as a non-zero exit code', async () => {
  // A process terminated by a signal reaches 'close' with code===null and a
  // signal on POSIX — `code ?? 0` would have resolved that as SUCCESS. On
  // Windows a kill carries an exit code, which is likewise non-zero. Either
  // way, a signal death must never look like exit 0.
  const r = await exec(
    process.execPath,
    ['-e', 'process.kill(process.pid, "SIGKILL")'],
    process.cwd(),
  );
  assert.notEqual(r.code, 0, `signal-killed process resolved code=${r.code}`);
});

// Helper: run git through the module-under-test's spawn wrapper, failing the
// test loudly if a setup command itself errors (so a broken fixture can't be
// mistaken for the behaviour we're asserting).
async function git(args: string[], cwd: string): Promise<string> {
  const r = await exec('git', args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
  }
  return r.stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q'], dir);
  const id = [
    '-c',
    'user.email=t@lattice.test',
    '-c',
    'user.name=lattice',
    '-c',
    'commit.gpgsign=false',
  ];
  await exec('node', ['-e', 'require("fs").writeFileSync("a.txt","v1")'], dir);
  await git(['add', '-A'], dir);
  await git([...id, 'commit', '-m', 'A'], dir);
  // A branch pinned at the first commit, so HEAD can move ahead of it.
  await git(['branch', 'base'], dir);
  await exec('node', ['-e', 'require("fs").writeFileSync("a.txt","v2")'], dir);
  await git(['add', '-A'], dir);
  await git([...id, 'commit', '-m', 'B'], dir);
}

test('countBetween throws on a git failure instead of returning 0', async () => {
  await withTempDir('lattice-countbetween-', async (dir) => {
    await initRepo(dir);

    // Sanity: a genuine empty range returns 0 without throwing...
    assert.equal(await countBetween(dir, 'HEAD', 'HEAD'), 0);
    // ...and a real non-empty range is counted, not swallowed.
    assert.equal(await countBetween(dir, 'base', 'HEAD'), 1);

    // The failure path a signal death now follows (non-zero exit): countBetween
    // MUST throw rather than parse '' → NaN → 0 and report the branch empty.
    await assert.rejects(
      () => countBetween(dir, 'HEAD', 'no-such-ref-deadbeef'),
      /git rev-list --count .* failed/,
    );
  });
});
