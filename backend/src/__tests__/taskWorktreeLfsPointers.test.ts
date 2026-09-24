import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { addWorktreeWithRetries } from '../worktree/setupAdd.js';
import { runWorktreeMerge } from '../worktree/merge/runWorktreeMerge.js';
import { projectGit, assertAllowedProjectGitEnv, DisallowedProjectGitError } from '../worktree/projectGit.js';
import {
  lfsCheckoutEnv,
  taskWorktreeLfsMode,
  worktreeCheckoutEnv,
} from '../worktree/lfsMode.js';
import { lfsPointerNoteFor, listLfsTrackedPaths } from '../worktree/lfsPaths.js';
import {
  estimateCheckoutBytes,
  POINTER_FILE_BYTES,
  resetDiskSpaceStateForTests,
} from '../worktree/diskSpace.js';
import { resolveHarnessSpawnBody } from '../terminalServerClient/createSession.js';
import { patchUserSettings, taskWorktreeLfsContentIn } from '../userSettings.js';
import { homeWorktreesDir } from '../projectPath.js';
import { withTempDir } from './helpers/tempDir.js';

// Task worktrees check Git LFS files out as pointer stubs by default
// (worktree/lfsMode.ts): 22 Ready-to-Merge worktrees of an LFS-heavy repo
// (7.4 GB each, 4.8 GB of it LFS content) filled a disk on 2026-09-23.

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const BIN_BYTES = 300 * 1024;

function lfsAvailable(): boolean {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    // The filter must be configured (system gitconfig) — HOME is isolated here.
    return execFileSync('git', ['config', '--get', 'filter.lfs.smudge'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env },
  );
}

async function headOf(file: string): Promise<string> {
  return (await fs.readFile(file)).subarray(0, LFS_POINTER_PREFIX.length).toString('latin1');
}

// A repo tracking *.bin through LFS, with one large .bin and one text file.
async function makeLfsRepo(root: string): Promise<string> {
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  // Repo-local (shared with its worktrees), so every checkout agrees on EOLs.
  git(repo, ['config', 'core.autocrlf', 'false']);
  // runWorktreeMerge commits with the ambient identity; HOME is isolated here.
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 't']);
  // userSettings.json lives in <repo>/.lattice/ — keep it out of `git status`.
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.lattice/\n');
  await fs.writeFile(path.join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  await fs.writeFile(path.join(repo, 'asset.bin'), crypto.randomBytes(BIN_BYTES));
  await fs.writeFile(path.join(repo, 'code.txt'), 'hello\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

test('taskWorktreeLfsContent defaults to pointers', async () => {
  assert.equal(taskWorktreeLfsContentIn({}), 'pointers');
  assert.equal(taskWorktreeLfsContentIn({ taskWorktreeLfsContent: 'full' }), 'full');
  assert.equal(taskWorktreeLfsContentIn({ taskWorktreeLfsContent: 'junk' as never }), 'pointers');
  await withTempDir('lattice-lfs-setting-', async (dir) => {
    assert.equal(await taskWorktreeLfsMode(dir), 'pointers');
    assert.deepEqual(lfsCheckoutEnv('pointers'), { GIT_LFS_SKIP_SMUDGE: '1' });
    await patchUserSettings(dir, { taskWorktreeLfsContent: 'full' });
    assert.equal(await taskWorktreeLfsMode(dir), 'full');
    assert.equal(lfsCheckoutEnv('full'), undefined);
  });
});

test('projectGit passes GIT_LFS_SKIP_SMUDGE and refuses any other env var', () => {
  assertAllowedProjectGitEnv(undefined);
  assertAllowedProjectGitEnv({ GIT_LFS_SKIP_SMUDGE: '1' });
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS']) {
    assert.throws(() => assertAllowedProjectGitEnv({ [key]: 'x' }), DisallowedProjectGitError);
  }
});

test('pointer-mode worktree: pointers in, clean status, merge keeps pointers, FF main smudges', { skip: !lfsAvailable() && 'git-lfs not available' }, async () => {
  await withTempDir('lattice-lfs-wt-', async (root) => {
    const repo = await makeLfsRepo(root);
    const worktreesDir = homeWorktreesDir(repo);
    const wt = path.join(worktreesDir, 'lfs-abc');
    const branch = 'lattice/lfs-abc';
    try {
      // The real setup path, with the env setup.ts passes in pointer mode.
      await addWorktreeWithRetries(repo, {
        slug: 'lfs',
        shortId: 'abc',
        worktreesDir,
        candidates: [{ attempt: 0, suffix: '', candidatePath: wt, candidateBranch: branch }],
      }, 'lfs task', lfsCheckoutEnv(await taskWorktreeLfsMode(repo)));
      assert.equal(await headOf(path.join(wt, 'asset.bin')), LFS_POINTER_PREFIX);
      assert.ok((await fs.stat(path.join(wt, 'asset.bin'))).size < 1024);
      assert.equal(git(wt, ['status', '--porcelain']), '', 'a pointer-stub worktree reads clean');

      // Task work on the branch; main moves on, including a new asset.bin.
      await fs.appendFile(path.join(wt, 'code.txt'), 'task edit\n');
      git(wt, ['commit', '-q', '-am', 'task']);
      const newBin = crypto.randomBytes(BIN_BYTES);
      await fs.writeFile(path.join(repo, 'asset.bin'), newBin);
      await fs.writeFile(path.join(repo, 'other.txt'), 'main\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '-m', 'main moves']);
      const mainSha = git(repo, ['rev-parse', 'HEAD']).trim();

      // The worktree-side merge reads the (default) setting itself.
      assert.deepEqual(await worktreeCheckoutEnv(wt), { GIT_LFS_SKIP_SMUDGE: '1' });
      const merged = await runWorktreeMerge(wt, branch, mainSha, 'merge main');
      assert.equal(merged.code, 0, merged.stderr);
      assert.equal(git(wt, ['status', '--porcelain']), '');
      assert.equal(await headOf(path.join(wt, 'asset.bin')), LFS_POINTER_PREFIX);

      // Main's fast-forward runs with the normal env: real content.
      const ff = await projectGit(repo, ['merge', '--ff-only', branch]);
      assert.equal(ff.code, 0, ff.stderr);
      assert.ok((await fs.readFile(path.join(repo, 'asset.bin'))).equals(newBin));
      assert.equal(git(repo, ['status', '--porcelain']), '');
      assert.match(await fs.readFile(path.join(repo, 'code.txt'), 'utf8'), /task edit/);

      // The agent's escape hatch works from the local LFS store (no remote).
      git(wt, ['lfs', 'pull', '--include=asset.bin']);
      assert.ok((await fs.readFile(path.join(wt, 'asset.bin'))).equals(newBin));
      assert.equal(git(wt, ['status', '--porcelain']), '');

      // 'full' mode: the merge-side env is dropped.
      await patchUserSettings(repo, { taskWorktreeLfsContent: 'full' });
      assert.equal(await worktreeCheckoutEnv(wt), undefined);
    } finally {
      await projectGit(repo, ['worktree', 'remove', '--force', wt]).catch(() => {});
      await fs.rm(worktreesDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

test('disk estimate counts LFS files as pointer stubs in pointer mode, keyed by mode', { skip: !lfsAvailable() && 'git-lfs not available' }, async () => {
  await withTempDir('lattice-lfs-est-', async (root) => {
    const repo = await makeLfsRepo(root);
    resetDiskSpaceStateForTests();
    assert.deepEqual(await listLfsTrackedPaths(repo), ['asset.bin']);
    const full = await estimateCheckoutBytes(repo, 'full');
    const pointers = await estimateCheckoutBytes(repo, 'pointers');
    assert.ok(full !== null && pointers !== null);
    assert.ok(full >= BIN_BYTES, `full estimate ${full} includes the LFS content`);
    // .gitattributes + code.txt (one cluster each) + one pointer stub.
    assert.equal(pointers, 2 * 4096 + POINTER_FILE_BYTES);
    assert.equal(full - pointers, Math.ceil(BIN_BYTES / 4096) * 4096 - POINTER_FILE_BYTES);
  });
});

test('LATTICE_TASK.md LFS note only for pointer mode on a repo with LFS files', { skip: !lfsAvailable() && 'git-lfs not available' }, async () => {
  await withTempDir('lattice-lfs-note-', async (root) => {
    const repo = await makeLfsRepo(root);
    const note = await lfsPointerNoteFor(repo, 'pointers');
    assert.ok(note);
    assert.match(note, /pointer stubs/);
    assert.match(note, /git lfs pull --include="<path>"/);
    assert.match(note, /`\*\.bin`/);
    assert.ok(!note.includes('\n'), 'one paragraph, so it composes into the env-notes blockquote');
    assert.equal(await lfsPointerNoteFor(repo, 'full'), null);

    const plain = path.join(root, 'plain');
    await fs.mkdir(plain);
    git(plain, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(plain, 'a.txt'), 'a\n');
    git(plain, ['add', '-A']);
    git(plain, ['commit', '-q', '-m', 'init']);
    assert.equal(await lfsPointerNoteFor(plain, 'pointers'), null);
  });
});

test('a task-worktree pty gets GIT_LFS_SKIP_SMUDGE in pointer mode only', async () => {
  await withTempDir('lattice-lfs-pty-', async (project) => {
    const cwd = path.join(homeWorktreesDir(project), 'task-abc');
    const scoped = await resolveHarnessSpawnBody({ cwd, projectPath: project, mcpScope: 'task-worktree' });
    assert.equal(scoped.managedMcpEnv?.GIT_LFS_SKIP_SMUDGE, '1');
    const unscoped = await resolveHarnessSpawnBody({ cwd, projectPath: project });
    assert.equal(unscoped.managedMcpEnv, undefined);
    await patchUserSettings(project, { taskWorktreeLfsContent: 'full' });
    const full = await resolveHarnessSpawnBody({ cwd, projectPath: project, mcpScope: 'task-worktree' });
    assert.equal(full.managedMcpEnv, undefined);
  });
});
