import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalProjectPath, projectHash, homeProjectDir, homeWorktreesDir } from '../projectPath.js';
import { clearProjectIdentityCaches, ProjectIdentityConflictError } from '../projectIdentity.js';
import { acquireProjectRunLock, ProjectRunLockedError } from '../projectRunLock.js';
import { listTasks } from '../tasks.js';
import { TaskCacheManager } from '../taskCache/manager.js';
import { loadPersistedWorkflowRuns } from '../workflowRuns/persistence.js';
import { normalizeLoadedRuns } from '../mergeRuns/normalization.js';
import { recoverPendingSnapshots } from '../worktree/snapshot/recovery.js';

const home = path.join(os.homedir(), '.lattice');
function oldHash(input: string) {
  let resolved = path.resolve(input);
  if (process.platform === 'win32') resolved = resolved[0].toUpperCase() + resolved.slice(1);
  return createHash('sha1').update(resolved).digest('hex').slice(0, 12);
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  clearProjectIdentityCaches();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-identity-'));
  t.after(async () => { clearProjectIdentityCaches(); await fs.rm(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'PhysicalRepo');
  const alias = path.join(root, 'ProjectAlias');
  await fs.mkdir(repo);
  await fs.symlink(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, repo, alias };
}

test('case and junction aliases share cache, state, and cross-process lock identity', async (t) => {
  const { repo, alias } = await fixture(t);
  assert.equal(canonicalProjectPath(alias), canonicalProjectPath(repo));
  assert.equal(projectHash(alias), projectHash(repo));
  if (process.platform === 'win32') {
    assert.equal(canonicalProjectPath(repo.toLowerCase()), canonicalProjectPath(repo));
    assert.equal(projectHash(repo.toUpperCase()), projectHash(repo));
  }
  const lock = await acquireProjectRunLock(alias, 'alias-owner');
  await assert.rejects(acquireProjectRunLock(repo, 'physical-contender'), ProjectRunLockedError);
  await lock.release();
});

test('legacy storage hash and worktree/snapshot locations survive physical canonicalization and restart', async (t) => {
  const { repo, alias } = await fixture(t);
  const legacy = oldHash(alias);
  const stored = path.join(home, 'per-project', legacy);
  await fs.mkdir(stored, { recursive: true });
  const tasks = [{ id: 'legacy-identity-task', projectPath: alias, title: 'keep legacy work', status: 'in_progress', createdAt: 1 }];
  await fs.writeFile(path.join(stored, 'tasks.json'), JSON.stringify(tasks));
  await fs.mkdir(path.join(home, 'worktrees', legacy, 'task'), { recursive: true });
  assert.equal(projectHash(repo), legacy);
  assert.equal(homeProjectDir(alias), stored);
  assert.equal(homeWorktreesDir(repo), path.join(home, 'worktrees', legacy));
  assert.equal((await listTasks(repo))[0]?.id, tasks[0].id);
  clearProjectIdentityCaches();
  assert.equal(projectHash(repo), legacy, 'durable binding survives normalized index/task paths');
  assert.equal(projectHash(alias), legacy);
  assert.equal(await fs.readFile(path.join(stored, 'tasks.json'), 'utf8'), JSON.stringify(tasks));
});

test('multiple legacy stores are preserved and rejected instead of silently choosing a board', async (t) => {
  const { repo, alias } = await fixture(t);
  const roots = [repo, alias];
  for (const project of roots) {
    const dir = path.join(home, 'per-project', oldHash(project));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify([{ id: oldHash(project), projectPath: project }]));
  }
  assert.throws(() => projectHash(repo), ProjectIdentityConflictError);
  await assert.rejects(acquireProjectRunLock(alias, 'must-not-mutate'), ProjectIdentityConflictError);
  for (const project of roots) {
    const dir = path.join(home, 'per-project', oldHash(project));
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'))[0].projectPath, project);
    await assert.rejects(fs.access(path.join(dir, 'run.lock')), { code: 'ENOENT' });
  }
});

test('repeated identity comparisons avoid repeated realpath calls and state scans', async (t) => {
  const { repo } = await fixture(t);
  const realpath = syncFs.realpathSync.native;
  let resolutions = 0;
  t.mock.method(syncFs.realpathSync, 'native', (...args: Parameters<typeof realpath>) => { resolutions++; return realpath(...args); });
  const expected = canonicalProjectPath(repo);
  for (let i = 0; i < 1000; i++) assert.equal(canonicalProjectPath(repo), expected);
  assert.equal(resolutions, 1);
  const hash = projectHash(repo);
  t.mock.method(syncFs, 'readFileSync', () => assert.fail('hot identity lookup must not rescan state'));
  for (let i = 0; i < 1000; i++) assert.equal(projectHash(repo), hash);
});

test('nonexistent paths are not negatively cached before directory creation', async (t) => {
  const { root, repo } = await fixture(t);
  const later = path.join(root, 'LaterAlias');
  assert.equal(canonicalProjectPath(later), later);
  await fs.symlink(repo, later, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(canonicalProjectPath(later), canonicalProjectPath(repo));
});

test('removing or retargeting a legacy junction does not hide tasks or lend its old store to another project', async (t) => {
  const { root, repo, alias } = await fixture(t);
  const legacy = oldHash(alias);
  const stored = path.join(home, 'per-project', legacy);
  await fs.mkdir(stored, { recursive: true });
  await fs.writeFile(path.join(stored, 'tasks.json'), JSON.stringify([{ id: 'junction-history', projectPath: alias, title: 'preserved', status: 'in_progress', createdAt: 1 }]));
  await fs.writeFile(path.join(stored, 'workflow-runs.json'), JSON.stringify([{ id: 'legacy-workflow', workflowId: 'wf', projectPath: alias, status: 'running', currentStepIndex: 0, totalSteps: 1, startedAt: 1 }]));
  const mergeRun = { id: 'legacy-merge', projectPath: alias, status: 'errored', startedAt: 1 };
  const snapshot = path.join(home, 'snapshots', legacy, 'historical');
  await fs.mkdir(snapshot, { recursive: true });
  await fs.writeFile(path.join(snapshot, 'note.txt'), 'preserved historical notes');
  await fs.writeFile(path.join(snapshot, '_lattice-snapshot.json'), JSON.stringify({ version: 1, repoRoot: alias, label: 'old-run', createdAt: 1, modifiedTracked: [], untracked: ['note.txt'] }));
  assert.equal(projectHash(repo), legacy);
  await fs.unlink(alias);
  clearProjectIdentityCaches();
  assert.equal(projectHash(repo), legacy);
  assert.equal((await new TaskCacheManager().listTasks(repo))[0]?.projectPath, canonicalProjectPath(repo));
  assert.equal((await loadPersistedWorkflowRuns(repo))[0]?.projectPath, canonicalProjectPath(repo));
  assert.equal(normalizeLoadedRuns([mergeRun], repo)[0]?.projectPath, canonicalProjectPath(repo));
  await recoverPendingSnapshots();
  assert.equal(await fs.readFile(path.join(repo, 'note.txt'), 'utf8'), 'preserved historical notes');
  const other = path.join(root, 'DifferentRepo');
  await fs.mkdir(other);
  await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  clearProjectIdentityCaches();
  assert.notEqual(projectHash(alias), legacy);
  assert.equal(projectHash(repo), legacy);
  assert.equal((await new TaskCacheManager().listTasks(repo))[0]?.id, 'junction-history');
  assert.equal((await loadPersistedWorkflowRuns(repo))[0]?.projectPath, canonicalProjectPath(repo));
  assert.equal(normalizeLoadedRuns([mergeRun], repo)[0]?.projectPath, canonicalProjectPath(repo));
});

test('one ambiguous project does not prevent loading another project\'s tasks', async (t) => {
  const { root, repo, alias } = await fixture(t);
  for (const project of [repo, alias]) {
    const dir = path.join(home, 'per-project', oldHash(project));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify([{ id: oldHash(project), projectPath: project }]));
  }
  const good = path.join(root, 'UnrelatedRepo');
  await fs.mkdir(good);
  const dir = path.join(home, 'per-project', oldHash(good));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify([{ id: 'unrelated-task', projectPath: good }]));
  const manager = new TaskCacheManager();
  await manager.projectsIndex.loadKnownProjects();
  manager.projectsIndex.add(repo);
  manager.projectsIndex.add(good);
  await manager.loadAllKnown();
  assert.equal((await manager.getTask('unrelated-task'))?.id, 'unrelated-task');
});

test('stray files and incomplete snapshot metadata do not break project identity discovery', async (t) => {
  const { root, repo } = await fixture(t);
  const strayHash = oldHash(path.join(root, 'stray'));
  await fs.mkdir(path.join(home, 'snapshots', strayHash, 'incomplete'), { recursive: true });
  await fs.writeFile(path.join(home, 'snapshots', strayHash, 'README.txt'), 'manual recovery notes');
  await fs.mkdir(path.join(home, 'snapshots', strayHash, 'incomplete', '_lattice-snapshot.json'));
  await fs.writeFile(path.join(home, 'per-project', strayHash), 'not a project directory');
  assert.equal(projectHash(repo), oldHash(canonicalProjectPath(repo)));
  assert.equal(await fs.readFile(path.join(home, 'snapshots', strayHash, 'README.txt'), 'utf8'), 'manual recovery notes');
});

test('unreadable legacy identity evidence refuses a new binding and preserves the store', async (t) => {
  const { repo, alias } = await fixture(t);
  const legacy = oldHash(alias);
  const dir = path.join(home, 'per-project', legacy);
  const file = path.join(dir, 'tasks.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify([{ id: 'unreadable', projectPath: alias }]));
  const originalOpen = syncFs.openSync;
  t.mock.method(syncFs, 'openSync', (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]) === file) throw Object.assign(new Error('unreadable legacy evidence'), { code: 'EACCES' });
    return originalOpen(...args);
  });
  assert.throws(() => projectHash(repo), { code: 'EACCES' });
  await assert.rejects(fs.access(path.join(home, 'project-identities', `${oldHash(canonicalProjectPath(repo))}.json`)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8'))[0].id, 'unreadable');
});

for (const failure of ['corrupt', 'unreadable'] as const) {
  test(`a ${failure} old binding cannot lend stored tasks to a retargeted junction`, async (t) => {
    const { root, repo, alias } = await fixture(t);
    const legacy = oldHash(alias);
    const dir = path.join(home, 'per-project', legacy);
    await fs.mkdir(dir, { recursive: true });
    const taskBytes = JSON.stringify([{ id: 'original-project-task', projectPath: alias }]);
    await fs.writeFile(path.join(dir, 'tasks.json'), taskBytes);
    assert.equal(projectHash(repo), legacy);
    const bindingFile = path.join(home, 'project-identities', `${oldHash(canonicalProjectPath(repo))}.json`);
    const bindingBytes = await fs.readFile(bindingFile, 'utf8');
    t.after(() => fs.writeFile(bindingFile, bindingBytes));
    await fs.unlink(alias);
    const other = path.join(root, 'RetargetedProject');
    await fs.mkdir(other);
    await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    if (failure === 'corrupt') await fs.writeFile(bindingFile, '{broken binding');
    else {
      const originalRead = syncFs.readFileSync;
      t.mock.method(syncFs, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
        if (String(args[0]) === bindingFile) throw Object.assign(new Error('binding unavailable'), { code: 'EACCES' });
        return originalRead(...args);
      });
    }
    clearProjectIdentityCaches();
    assert.throws(() => projectHash(alias), /cannot validate identity binding/);
    await assert.rejects(fs.access(path.join(home, 'project-identities', `${oldHash(canonicalProjectPath(other))}.json`)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'), taskBytes);
  });
}

test('warm task reads preserve cached task objects after initial identity normalization', async (t) => {
  const { repo, alias } = await fixture(t);
  const dir = path.join(home, 'per-project', oldHash(alias));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify([{ id: 'warm-task', projectPath: alias }]));
  const manager = new TaskCacheManager();
  const first = (await manager.listTasks(repo))[0];
  assert.equal(first.projectPath, canonicalProjectPath(repo));
  for (let i = 0; i < 100; i++) assert.equal((await manager.listTasks(alias))[0], first);
});
