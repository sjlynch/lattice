// Coverage for the merge-run circuit breaker (`.git`-deletion defence #6):
// between tasks, a merge-all halts if the project `.git` vanished or HEAD
// moved anywhere other than *forward*. Both directions matter — a breaker
// that fails to fire keeps hammering merges onto an already-damaged repo,
// and one that misfires strands every remaining ready_to_merge task.
//
// The `.git`-missing / null-baseline branches are pure fs (no git spawn);
// the forward/non-forward branches drive a real temp repo through
// `execFile`, same style as `inProgressSweepEligibility.test.ts`.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRepoIntegrity } from '../mergeRuns/repoIntegrity.js';
import { withTempDir } from './helpers/tempDir.js';

const execFileAsync = promisify(execFile);
const PREFIX = 'lattice-repo-integrity-';

type Integrity = Awaited<ReturnType<typeof checkRepoIntegrity>>;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function commit(repo: string, file: string, contents: string): Promise<string> {
  await fs.writeFile(path.join(repo, file), contents, 'utf8');
  await git(repo, ['add', file]);
  await git(repo, ['commit', '-m', `add ${file}`]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

// Bare `git init` + identity, no commits (HEAD is unborn).
async function initEmptyRepo(repo: string): Promise<void> {
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'lattice-test@example.invalid']);
  await git(repo, ['config', 'user.name', 'Lattice Test']);
}

// Narrow the discriminated union so the reason is readable.
function expectHalt(result: Integrity): string {
  if (result.ok) assert.fail(`expected the breaker to trip, got ${JSON.stringify(result)}`);
  return result.reason;
}

function expectOk(result: Integrity): void {
  assert.deepEqual(result, { ok: true });
}

// --- pure-fs branches ----------------------------------------------------------

test('checkRepoIntegrity halts when the project .git is gone', async () => {
  await withTempDir(PREFIX, async (repo) => {
    // No `.git` at all — the catastrophic case the breaker exists for. A
    // non-null baseline proves the fs probe gates *before* any git spawn
    // (git in a dirless tree walks up and can latch onto another repo).
    const reason = expectHalt(await checkRepoIntegrity(repo, 'a'.repeat(40)));
    assert.match(reason, /\.git is missing/);
    assert.ok(reason.includes(repo), 'reason should name the repo that lost its .git');
  });
});

test('checkRepoIntegrity does not false-trip when the baseline HEAD is null', async () => {
  await withTempDir(PREFIX, async (repo) => {
    // A bogus (empty) `.git` dir: `gitDirExists` is satisfied, but any real
    // git command here would fail. A null baseline (HEAD unreadable at run
    // start) must therefore short-circuit to ok — if it instead fell
    // through to `rev-parse`, this would come back as a halt.
    await fs.mkdir(path.join(repo, '.git'));

    expectOk(await checkRepoIntegrity(repo, null));
  });
});

// --- HEAD-movement branches (real temp repo) -----------------------------------

test('checkRepoIntegrity passes when HEAD has not moved', async () => {
  await withTempDir(PREFIX, async (repo) => {
    await initEmptyRepo(repo);
    const head = await commit(repo, 'base.txt', 'base\n');

    expectOk(await checkRepoIntegrity(repo, head));
  });
});

test('checkRepoIntegrity passes when HEAD moved forward (fast-forward)', async () => {
  await withTempDir(PREFIX, async (repo) => {
    await initEmptyRepo(repo);
    const baseline = await commit(repo, 'base.txt', 'base\n');
    const head = await commit(repo, 'next.txt', 'next\n');
    assert.notEqual(head, baseline);

    // A descendant of the baseline: exactly what a merge run's `--ff-only`
    // main advance produces, so it must NOT trip the breaker.
    expectOk(await checkRepoIntegrity(repo, baseline));
  });
});

test('checkRepoIntegrity halts when HEAD moved sideways to a non-descendant', async () => {
  await withTempDir(PREFIX, async (repo) => {
    await initEmptyRepo(repo);
    const root = await commit(repo, 'base.txt', 'base\n');
    const baseline = await commit(repo, 'next.txt', 'next\n');

    // Rewind to the root and commit elsewhere: HEAD is now unreachable from
    // the baseline, i.e. a reset/checkout/rewrite happened mid-run.
    await git(repo, ['checkout', '-b', 'sideways', root]);
    const sideways = await commit(repo, 'other.txt', 'other\n');

    const reason = expectHalt(await checkRepoIntegrity(repo, baseline));
    assert.match(reason, /^HEAD moved non-forward: /);
    assert.ok(reason.includes(baseline.slice(0, 10)), 'reason should name the baseline commit');
    assert.ok(reason.includes(sideways.slice(0, 10)), 'reason should name the current HEAD');
  });
});

test('checkRepoIntegrity halts when HEAD cannot be read', async () => {
  await withTempDir(PREFIX, async (repo) => {
    // `.git` exists and git is happy with the repo, but HEAD is unborn (no
    // commits) so `rev-parse HEAD` exits non-zero. A baseline exists, so
    // the run started from a readable HEAD and this is a real regression.
    await initEmptyRepo(repo);

    const reason = expectHalt(await checkRepoIntegrity(repo, 'a'.repeat(40)));
    assert.match(reason, /^cannot read HEAD: /);
  });
});
