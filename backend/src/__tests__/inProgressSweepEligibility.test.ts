import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../tasks.js';
import { normalizeCwd } from '../recovery/liveSessions.js';
import { MIN_AGE_MS } from '../recovery/inProgressSweep/config.js';
import { decideAutoComplete } from '../recovery/inProgressSweep/eligibility.js';
import { withTempDir } from './helpers/tempDir.js';

const execFileAsync = promisify(execFile);
const NOW = 1_700_000_000_000;
const OLD_STARTED_AT = NOW - MIN_AGE_MS - 1_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_in_progress_sweep_eligibility',
    projectPath: path.join(process.cwd(), 'missing-project'),
    title: 'in-progress sweep eligibility fixture',
    status: 'in_progress',
    createdAt: OLD_STARTED_AT,
    startedAt: OLD_STARTED_AT,
    worktreePath: path.join(process.cwd(), 'missing-worktree'),
    branch: 'lattice/fixture',
    ...overrides,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepoWithBranches(repo: string): Promise<void> {
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'lattice-test@example.invalid']);
  await git(repo, ['config', 'user.name', 'Lattice Test']);

  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n', 'utf8');
  await git(repo, ['add', 'file.txt']);
  await git(repo, ['commit', '-m', 'base']);

  const baseBranch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(repo, ['branch', 'lattice/no-commits']);

  await git(repo, ['checkout', '-b', 'lattice/one-ahead']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\nbranch\n', 'utf8');
  await git(repo, ['add', 'file.txt']);
  await git(repo, ['commit', '-m', 'branch change']);
  await git(repo, ['checkout', baseBranch]);
}

test('decideAutoComplete skips tasks missing worktreePath or branch', async () => {
  for (const overrides of [{ worktreePath: undefined }, { branch: undefined }]) {
    const verdict = await decideAutoComplete({
      task: task(overrides),
      liveCwds: new Set(),
      now: NOW,
    });

    assert.deepEqual(verdict, {
      decision: 'skip',
      reason: { code: 'no-worktree-or-branch' },
    });
  }
});

test('decideAutoComplete skips young tasks before inspecting git', async () => {
  const verdict = await decideAutoComplete({
    task: task({
      projectPath: path.join(process.cwd(), 'definitely-not-a-git-repo'),
      startedAt: NOW - MIN_AGE_MS + 1,
    }),
    liveCwds: new Set(),
    now: NOW,
  });

  assert.deepEqual(verdict, {
    decision: 'skip',
    reason: { code: 'too-young' },
  });
});

test('decideAutoComplete skips when the worktree cwd still has a live session', async () => {
  const worktreePath = path.join(process.cwd(), 'live-worktree');
  const verdict = await decideAutoComplete({
    task: task({
      projectPath: path.join(process.cwd(), 'definitely-not-a-git-repo'),
      worktreePath,
    }),
    liveCwds: new Set([normalizeCwd(worktreePath)]),
    now: NOW,
  });

  assert.deepEqual(verdict, {
    decision: 'skip',
    reason: { code: 'session-live' },
  });
});

test('decideAutoComplete skips an existing branch with zero commits over HEAD', async () => {
  await withTempDir('lattice-in-progress-eligibility-', async (repo) => {
    await initRepoWithBranches(repo);

    const verdict = await decideAutoComplete({
      task: task({ projectPath: repo, branch: 'lattice/no-commits' }),
      liveCwds: new Set(),
      now: NOW,
    });

    assert.deepEqual(verdict, {
      decision: 'skip',
      reason: { code: 'no-commits' },
    });
  });
});

test('decideAutoComplete reports commit-count-failed for a missing branch', async () => {
  await withTempDir('lattice-in-progress-eligibility-', async (repo) => {
    await initRepoWithBranches(repo);

    const verdict = await decideAutoComplete({
      task: task({ projectPath: repo, branch: 'lattice/missing' }),
      liveCwds: new Set(),
      now: NOW,
    });

    assert.equal(verdict.decision, 'skip');
    assert.equal(verdict.reason.code, 'commit-count-failed');
    assert.ok(verdict.reason.error instanceof Error);
  });
});

test('decideAutoComplete completes an old lattice branch one commit ahead of HEAD', async () => {
  await withTempDir('lattice-in-progress-eligibility-', async (repo) => {
    await initRepoWithBranches(repo);

    const verdict = await decideAutoComplete({
      task: task({ projectPath: repo, branch: 'lattice/one-ahead' }),
      liveCwds: new Set(),
      now: NOW,
    });

    assert.deepEqual(verdict, {
      decision: 'complete',
      commits: 1,
      ageMs: MIN_AGE_MS + 1_000,
    });
  });
});
