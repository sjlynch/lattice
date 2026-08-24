import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  restoreLatticeManagedFiles,
  shelveLatticeManagedFiles,
} from '../worktree/mergeOwnedFiles.js';
import { LATTICE_SHELVE_PATHS } from '../worktree/managedFiles.js';
import { exec } from '../worktree/exec.js';

// Regression: a merge run on C:\development\interview_eci errored two of ten
// tasks with
//
//   error: The following untracked working tree files would be overwritten by
//   merge: .codex/hooks.json ... Aborting
//
// `.codex/hooks.json` had become tracked on main, and the shelve list that
// exists precisely to prevent that was a hardcoded two-entry array
// (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md) — so every Lattice-managed file
// added since was unprotected. The list now comes from LATTICE_SHELVE_PATHS,
// and shelving is untracked-only so a tracked file is never renamed aside
// (which would abort the merge for the opposite reason).

async function repo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-shelve-'));
  await exec('git', ['init', '-b', 'main'], dir);
  await exec('git', ['config', 'user.email', 'test@example.com'], dir);
  await exec('git', ['config', 'user.name', 'test'], dir);
  return dir;
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

test('the shelve list covers every managed file Lattice writes untracked', () => {
  const paths = new Set<string>(LATTICE_SHELVE_PATHS);
  for (const required of [
    'LATTICE_TASK.md',
    'MERGE_INSTRUCTIONS.md',
    '.claude/settings.local.json',
    '.pi/extensions/lattice-complete.ts',
    '.pi/mcp.json',
    '.codex/hooks.json',
  ]) {
    assert.ok(paths.has(required), `${required} must be shelved before a merge`);
  }
});

test('untracked managed files are shelved and restored; tracked ones are left alone', async () => {
  const dir = await repo();
  try {
    // A file the repo itself tracks — must NOT be renamed aside (git would
    // then see a local deletion and refuse the merge).
    await write(dir, 'README.md', 'hi');
    await write(dir, 'LATTICE_TASK.md', 'tracked-by-repo');
    await exec('git', ['add', '-A'], dir);
    await exec('git', ['commit', '-m', 'init'], dir);

    // Lattice's untracked copies.
    await write(dir, '.codex/hooks.json', '{"lattice":true}');
    await write(dir, '.claude/settings.local.json', '{"lattice":true}');

    const shelved = await shelveLatticeManagedFiles(dir);
    assert.deepEqual(
      [...shelved].sort(),
      ['.claude/settings.local.json', '.codex/hooks.json'],
      'only the untracked copies are shelved',
    );
    assert.equal(await exists(path.join(dir, '.codex/hooks.json')), false);
    assert.equal(
      await fs.readFile(path.join(dir, 'LATTICE_TASK.md'), 'utf8'),
      'tracked-by-repo',
      'a tracked managed file is never moved aside',
    );

    await restoreLatticeManagedFiles(dir, shelved);
    assert.equal(
      await fs.readFile(path.join(dir, '.codex/hooks.json'), 'utf8'),
      '{"lattice":true}',
    );
    assert.equal(
      await fs.readFile(path.join(dir, '.claude/settings.local.json'), 'utf8'),
      '{"lattice":true}',
    );
    assert.equal(await exists(path.join(dir, '.codex/hooks.json.lattice-bak')), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("restore keeps the repo's own .codex/hooks.json when the merge made it tracked", async () => {
  const dir = await repo();
  try {
    await write(dir, 'README.md', 'hi');
    await exec('git', ['add', '-A'], dir);
    await exec('git', ['commit', '-m', 'init'], dir);

    await write(dir, '.codex/hooks.json', '{"lattice":true}');
    await write(dir, '.claude/settings.local.json', '{"lattice":true}');
    const shelved = await shelveLatticeManagedFiles(dir);

    // Stand in for the merge materializing tracked versions of both paths.
    await write(dir, '.codex/hooks.json', '{"theirs":true}');
    await write(dir, '.claude/settings.local.json', '{"theirs":true}');
    await exec('git', ['add', '-A'], dir);
    await exec('git', ['commit', '-m', 'merge brought these in'], dir);

    await restoreLatticeManagedFiles(dir, shelved);

    assert.equal(
      await fs.readFile(path.join(dir, '.codex/hooks.json'), 'utf8'),
      '{"theirs":true}',
      "a non-owned file the merge tracked is the user's — Lattice's copy is dropped",
    );
    assert.equal(await exists(path.join(dir, '.codex/hooks.json.lattice-bak')), false);
    assert.equal(
      await fs.readFile(path.join(dir, '.claude/settings.local.json'), 'utf8'),
      '{"lattice":true}',
      'a Lattice-OWNED file always wins (its Stop-hook URL is per-worktree)',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
