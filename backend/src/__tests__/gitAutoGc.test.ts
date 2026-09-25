// 2026-09-24: git's own auto-gc, fired after the merges and commits of a
// merge run, repacked the ody repo (4.2 GB) over and over; on Windows the old
// packs could not be deleted while other git processes had them mapped, and
// 80 GB of pack copies + debris filled the disk. Pins: every git Lattice runs
// (and every agent it spawns) has auto-gc off; the one deliberate gc runs in
// the foreground; the debris sweep removes only dead, old files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withTempDir } from './helpers/tempDir.js';
import { gitConfigEnv, isGitCommand, NO_AUTO_GC } from '../worktree/gitAutoGc.js';
import { exec } from '../worktree/exec.js';
import { assertAllowedProjectGitArgs } from '../worktree/projectGit.js';
import { PACK_DEBRIS_MIN_AGE_MS, sweepPackDebris } from '../worktree/repoMaintenance.js';
import { resolveHarnessSpawnBody } from '../terminalServerClient/createSession.js';

const PREFIX = 'lattice-git-autogc-';

test('gitConfigEnv appends to an existing GIT_CONFIG_COUNT instead of clobbering it', () => {
  assert.deepEqual(gitConfigEnv(NO_AUTO_GC, {}), {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0',
    GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
  });
  const appended = gitConfigEnv([['gc.auto', '0']], { GIT_CONFIG_COUNT: '3' });
  assert.deepEqual(appended, { GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: 'gc.auto', GIT_CONFIG_VALUE_3: '0' });
  assert.ok(isGitCommand('git') && isGitCommand('C:\\Program Files\\Git\\cmd\\git.exe') && !isGitCommand('gitk'));
});

test('every git Lattice runs sees gc.auto=0; the housekeeping run sees foreground auto-gc', async (t) => {
  // Run with no inherited git config env: a suite launched from a
  // Lattice-spawned agent (e.g. a workflow's Run tests step) inherits
  // gc.auto=0, which foreground mode rightly keeps — and the last assertion
  // would then fail for a reason that isn't the code under test.
  const inherited = Object.keys(process.env).filter((k) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k));
  const saved = inherited.map((k) => [k, process.env[k]] as const);
  for (const k of inherited) delete process.env[k];
  t.after(() => {
    for (const [k, v] of saved) process.env[k] = v;
  });
  await withTempDir(PREFIX, async (repo) => {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const plain = await exec('git', ['config', '--get', 'gc.auto'], repo);
    assert.equal(plain.stdout.trim(), '0');
    assert.equal((await exec('git', ['config', '--get', 'maintenance.auto'], repo)).stdout.trim(), 'false');
    const fg = await exec('git', ['config', '--get', 'gc.autoDetach'], repo, { autoGc: 'foreground' });
    assert.equal(fg.stdout.trim(), 'false');
    // Foreground mode leaves gc.auto at git's (or the user's) setting.
    assert.notEqual((await exec('git', ['config', '--get', 'gc.auto'], repo, { autoGc: 'foreground' })).stdout.trim(), '0');
  });
});

test('project git allows only "gc --auto [--quiet]"', () => {
  assertAllowedProjectGitArgs(['gc', '--auto']);
  assertAllowedProjectGitArgs(['gc', '--auto', '--quiet']);
  assertAllowedProjectGitArgs(['count-objects', '-v']);
  for (const bad of [['gc'], ['gc', '--prune=now', '--auto'], ['gc', '--aggressive', '--auto']]) {
    assert.throws(() => assertAllowedProjectGitArgs(bad), /gc --auto/);
  }
});

test('the pack-debris sweep removes old temp packs and index-less packs only', async () => {
  await withTempDir(PREFIX, async (gitDir) => {
    const pack = path.join(gitDir, 'objects', 'pack');
    await fs.mkdir(pack, { recursive: true });
    await fs.mkdir(path.join(gitDir, 'objects', 'ab'), { recursive: true });
    const files: Record<string, boolean> = {
      // name → expected removed
      'tmp_pack_old': true,
      'pack-aaaa.pack': true, // no .idx → unreadable by git
      'pack-aaaa.rev': true,
      'pack-bbbb.pack': false, // has its .idx
      'pack-bbbb.idx': false,
      'pack-cccc.pack': false, // no .idx but a .keep
      'pack-cccc.keep': false,
    };
    for (const name of Object.keys(files)) await fs.writeFile(path.join(pack, name), 'x'.repeat(10));
    await fs.writeFile(path.join(gitDir, 'objects', 'ab', 'tmp_obj_old'), 'x');
    await fs.writeFile(path.join(pack, 'tmp_pack_young'), 'x');
    const old = new Date(Date.now() - PACK_DEBRIS_MIN_AGE_MS - 60_000);
    for (const name of Object.keys(files)) await fs.utimes(path.join(pack, name), old, old);
    await fs.utimes(path.join(gitDir, 'objects', 'ab', 'tmp_obj_old'), old, old);

    // A live gc owns the object store: nothing is touched.
    await fs.writeFile(path.join(gitDir, 'gc.pid'), '1 host');
    assert.deepEqual((await sweepPackDebris(gitDir)).removed, []);
    await fs.rm(path.join(gitDir, 'gc.pid'));

    const swept = await sweepPackDebris(gitDir);
    const removed = new Set(swept.removed.map((f) => path.basename(f)));
    for (const [name, expected] of Object.entries(files)) assert.equal(removed.has(name), expected, name);
    assert.ok(removed.has('tmp_obj_old'));
    assert.ok(!removed.has('tmp_pack_young'), 'a young temp pack may belong to a running git');
  });
});

test('agent sessions get auto-gc off in their env; a plain shell does not', async () => {
  await withTempDir(PREFIX, async (cwd) => {
    const agent = await resolveHarnessSpawnBody({ cwd, initialCommand: 'claude "x"' });
    assert.equal(agent.managedMcpEnv?.GIT_CONFIG_COUNT, String(Number(process.env.GIT_CONFIG_COUNT ?? 0) + 2));
    assert.ok(Object.values(agent.managedMcpEnv ?? {}).includes('gc.auto'));
    const shell = await resolveHarnessSpawnBody({ cwd, initialCommand: 'npm run dev' });
    assert.equal(shell.managedMcpEnv, undefined);
  });
});
