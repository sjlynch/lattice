import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { canonicalProjectPath } from '../projectPath.js';
import { projectTasksFile } from '../taskCache/paths.js';
import {
  isStructurallyJunkPath,
  shouldPruneProjectEntry,
} from '../taskCache/pruneIndex.js';
import { ProjectsIndex } from '../taskCache/projectsIndex.js';
import { PROJECTS_INDEX } from '../taskCache/paths.js';

const isWindows = process.platform === 'win32';
const driveRoot = path.parse(process.cwd()).root; // "C:\" or "/"

// A well-formed absolute path that is NOT under the OS temp dir and will not
// exist on disk — used to exercise the existence/task-data branches without
// tripping the structural (temp-dir) check.
function offlineProjectPath(name: string): string {
  return canonicalProjectPath(path.join(driveRoot, `__lattice_prune_test__${name}`));
}

// ---------- isStructurallyJunkPath (pure) ----------

test('isStructurallyJunkPath: temp-dir scratch is junk', () => {
  assert.equal(isStructurallyJunkPath(canonicalProjectPath(path.join(os.tmpdir(), 'lattice-canon-abc'))), true);
  // The temp root itself.
  assert.equal(isStructurallyJunkPath(canonicalProjectPath(os.tmpdir())), true);
});

test('isStructurallyJunkPath: control characters are junk', () => {
  // e.g. `C:\development\ody\rewrite` where `\r` became a carriage return.
  const mangled = `${driveRoot}development${String.fromCharCode(13)}ewrite`;
  assert.equal(isStructurallyJunkPath(mangled), true);
});

test('isStructurallyJunkPath: empty / relative paths are junk', () => {
  assert.equal(isStructurallyJunkPath(''), true);
  assert.equal(isStructurallyJunkPath('developmentlesser_evil'), true);
  assert.equal(isStructurallyJunkPath('.'), true);
});

test('isStructurallyJunkPath: a normal absolute project path is NOT junk', () => {
  assert.equal(isStructurallyJunkPath(offlineProjectPath('normal')), false);
  assert.equal(isStructurallyJunkPath(canonicalProjectPath(process.cwd())), false);
});

// ---------- shouldPruneProjectEntry (fs) ----------

test('shouldPruneProjectEntry: an existing directory is kept', async () => {
  // process.cwd() (the backend dir) exists and is not under os.tmpdir().
  assert.equal(await shouldPruneProjectEntry(canonicalProjectPath(process.cwd())), false);
});

test('shouldPruneProjectEntry: a non-existent, task-less path is pruned (phantom)', async () => {
  assert.equal(await shouldPruneProjectEntry(offlineProjectPath('phantom')), true);
});

test('shouldPruneProjectEntry: a non-existent path WITH task data is kept (offline drive)', async () => {
  const p = offlineProjectPath('offline-with-tasks');
  const tasksFile = projectTasksFile(p);
  await fs.mkdir(path.dirname(tasksFile), { recursive: true });
  await fs.writeFile(
    tasksFile,
    JSON.stringify([{ id: 't_x', projectPath: p, title: 'keep me', status: 'open', createdAt: 1 }]),
  );
  try {
    assert.equal(await shouldPruneProjectEntry(p), false);
  } finally {
    await fs.rm(path.dirname(tasksFile), { recursive: true, force: true });
  }
});

test('shouldPruneProjectEntry: temp-dir scratch is pruned even if it exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-prune-live-'));
  try {
    assert.equal(await shouldPruneProjectEntry(canonicalProjectPath(dir)), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------- ProjectsIndex.loadKnownProjects integration ----------

test('loadKnownProjects prunes junk and rewrites the index, keeping real projects', async () => {
  // The isolateHome preload points PROJECTS_INDEX at a throwaway home, so this
  // writes/reads only test scratch. process.cwd() is the real (surviving) entry:
  // it exists and is not under os.tmpdir().
  const realDir = canonicalProjectPath(process.cwd());
  const tempJunk = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-prune-junk-'));
  const phantom = offlineProjectPath('idx-phantom');
  const controlChar = `${driveRoot}dev${String.fromCharCode(13)}x`;

  try {
    await fs.mkdir(path.dirname(PROJECTS_INDEX), { recursive: true });
    await fs.writeFile(
      PROJECTS_INDEX,
      JSON.stringify([realDir, tempJunk, phantom, controlChar]),
    );

    const idx = new ProjectsIndex();
    await idx.loadKnownProjects();

    const kept = idx.list();
    assert.deepEqual(kept, [realDir], 'only the real dir survives');

    // The file was rewritten to the pruned set.
    const onDisk = JSON.parse(await fs.readFile(PROJECTS_INDEX, 'utf8'));
    assert.deepEqual(onDisk, [realDir]);
  } finally {
    await fs.rm(tempJunk, { recursive: true, force: true });
    await fs.rm(PROJECTS_INDEX, { force: true });
  }
});
