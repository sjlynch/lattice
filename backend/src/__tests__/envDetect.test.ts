import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  detectProjectEnvironments,
  describeProjectEnvs,
  defaultEnvNote,
  renderEnvNotesBlock,
} from '../worktree/envDetect.js';

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-envdetect-'));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return root;
}

function commitAll(root: string): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'],
    { cwd: root, stdio: 'ignore' },
  );
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: root, stdio: 'ignore' },
  );
}

test('detects a node project with a gitignored node_modules', async () => {
  const root = await makeRepo();
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}', 'utf8');
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');
    await fs.mkdir(path.join(root, 'node_modules', 'foo'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'foo', 'index.js'), '', 'utf8');

    const envs = await detectProjectEnvironments(root);
    assert.equal(envs.length, 1);
    assert.equal(envs[0].id, 'node');
    assert.equal(envs[0].manager, 'npm');
    assert.equal(envs[0].heavyDir, 'node_modules');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('picks pnpm when a pnpm lockfile is present', async () => {
  const root = await makeRepo();
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}', 'utf8');
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });

    const envs = await detectProjectEnvironments(root);
    assert.equal(envs.length, 1);
    assert.equal(envs[0].manager, 'pnpm');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not flag a node_modules that is tracked by git', async () => {
  const root = await makeRepo();
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}', 'utf8');
    await fs.mkdir(path.join(root, 'node_modules', 'foo'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'foo', 'index.js'), '', 'utf8');
    // No .gitignore — commit everything so node_modules is tracked.
    commitAll(root);

    const envs = await detectProjectEnvironments(root);
    assert.deepEqual(envs, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not flag a project that has no installed deps dir', async () => {
  const root = await makeRepo();
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}', 'utf8');
    // package.json but no node_modules — nothing to nag about.
    const envs = await detectProjectEnvironments(root);
    assert.deepEqual(envs, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bare directory detects nothing', async () => {
  const root = await makeRepo();
  try {
    assert.deepEqual(await detectProjectEnvironments(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('describeProjectEnvs honours overrides (custom, suppressed, default)', async () => {
  const root = await makeRepo();
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}', 'utf8');
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });

    const noOverride = await describeProjectEnvs(root, {});
    assert.equal(noOverride.length, 1);
    assert.equal(noOverride[0].effectiveNote, noOverride[0].defaultNote);
    assert.ok(noOverride[0].defaultNote.length > 0);

    const custom = await describeProjectEnvs(root, { worktreeEnvNotes: { node: 'do not install, ever' } });
    assert.equal(custom[0].effectiveNote, 'do not install, ever');

    const suppressed = await describeProjectEnvs(root, { worktreeEnvNotes: { node: '' } });
    assert.equal(suppressed[0].effectiveNote, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('renderEnvNotesBlock formats a blockquote (or empty string)', () => {
  assert.equal(renderEnvNotesBlock([]), '');
  assert.equal(renderEnvNotesBlock(['  ', '']), '');
  assert.equal(renderEnvNotesBlock(['one']), '> one\n\n');
  assert.equal(renderEnvNotesBlock(['one', 'two']), '> one\n>\n> two\n\n');
});

test('defaultEnvNote mentions the manager-specific install command', () => {
  const note = defaultEnvNote({
    id: 'node',
    label: 'Node.js',
    heavyDir: 'node_modules',
    manager: 'npm',
    installCmd: 'npm install --prefer-offline --no-audit --no-fund',
  });
  assert.ok(note.includes('npm install --prefer-offline'));
  assert.ok(note.includes('node_modules/'));
});
