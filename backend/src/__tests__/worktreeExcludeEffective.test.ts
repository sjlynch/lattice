import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeWorktreeExclude } from '../worktree/stopHook.js';
import { LATTICE_EXCLUDE_PATTERNS } from '../worktree/managedFiles.js';
import { exec } from '../worktree/exec.js';

// Regression: writeWorktreeExclude used to resolve the worktree's `.git`
// pointer file and append the patterns to `<repo>/.git/worktrees/<name>/info/
// exclude` — a file git NEVER READS. `info/exclude` is one of git's "common"
// files, read only from `git rev-parse --git-common-dir`. So every pattern was
// inert: `git status` inside a task worktree kept listing `?? LATTICE_TASK.md`
// and `?? .codex/hooks.json`, which is how an agent's `git add -A` committed a
// Lattice-generated `.codex/hooks.json` onto main and made `git merge` abort in
// every other worktree with "untracked working tree files would be overwritten
// by merge".
//
// This asserts the OUTCOME (git actually ignores the files), not the write
// location — the same bug in a different disguise would still fail this.

async function scaffold(): Promise<{ repo: string; wt: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-exclude-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  await fs.mkdir(repo, { recursive: true });
  await exec('git', ['init', '-b', 'main'], repo);
  await exec('git', ['config', 'user.email', 'test@example.com'], repo);
  await exec('git', ['config', 'user.name', 'test'], repo);
  await fs.writeFile(path.join(repo, 'README.md'), 'hi', 'utf8');
  await exec('git', ['add', '-A'], repo);
  await exec('git', ['commit', '-m', 'init'], repo);
  await exec('git', ['worktree', 'add', wt, '-b', 'lattice/t_1'], repo);
  return { repo, wt, root };
}

test('worktree excludes actually hide Lattice files from git inside the worktree', async () => {
  const { wt, root } = await scaffold();
  try {
    for (const rel of ['LATTICE_TASK.md', '.codex/hooks.json', '.claude/settings.local.json']) {
      const file = path.join(wt, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'lattice', 'utf8');
    }

    await writeWorktreeExclude(wt, [...LATTICE_EXCLUDE_PATTERNS]);

    const status = await exec('git', ['status', '--porcelain', '--untracked-files=all'], wt);
    assert.equal(
      status.stdout.trim(),
      '',
      `git must not see Lattice's files; it reported:\n${status.stdout}`,
    );

    // `git add -A` — what an agent does — must stage nothing.
    await exec('git', ['add', '-A'], wt);
    const staged = await exec('git', ['diff', '--cached', '--name-only'], wt);
    assert.equal(staged.stdout.trim(), '', 'git add -A must not stage Lattice files');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('writeWorktreeExclude is idempotent across repeated worktree setups', async () => {
  const { repo, wt, root } = await scaffold();
  try {
    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    await writeWorktreeExclude(wt, [...LATTICE_EXCLUDE_PATTERNS]);
    const once = await fs.readFile(excludeFile, 'utf8');
    await writeWorktreeExclude(wt, [...LATTICE_EXCLUDE_PATTERNS]);
    await writeWorktreeExclude(wt, [...LATTICE_EXCLUDE_PATTERNS]);
    const thrice = await fs.readFile(excludeFile, 'utf8');
    assert.equal(thrice, once, 'the shared exclude file must not grow per worktree');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
