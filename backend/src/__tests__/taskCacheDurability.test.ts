// Regression coverage for task-DB durability holes the earlier sweeps missed:
//
//  1. A tasks.json that PARSES but is not an array (`{}`) loaded as an empty
//     board WITHOUT being preserved, so the next mutation overwrote it.
//  2. Boot restore treated ANY read failure of tasks.json (a Windows share
//     lock) as "missing" and rolled the live DB back to the merge-run backup;
//     and it overwrote a corrupt main file without preserving its bytes.
//  3. First-touch legacy migration treated a home dir holding only
//     tasks.backup.json as un-migrated and copied the months-old in-project
//     file over the main file AND the newer backup.
//  4. The one-time global legacy migration threw on a row with no
//     projectPath (failing every later task load) and unlinked the legacy
//     file even when a project's rows failed to migrate.
//  5. A debounced persist still pending at `process.exit()` was dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TaskCacheManager } from '../taskCache/manager.js';
import { ProjectsIndex } from '../taskCache/projectsIndex.js';
import { TaskMigrations, migrateInProjectTasksToHome, migrateLegacy } from '../taskCache/migrations.js';
import { restoreTasksFromBackupIfMissing } from '../taskCache/recovery.js';
import {
  LEGACY_GLOBAL_TASKS,
  projectTasksBackupFile,
  projectTasksFile,
} from '../taskCache/paths.js';
import { canonicalProjectPath } from '../projectPath.js';

assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run with --import ./src/__tests__/helpers/isolateHome.mjs');

async function tmpProject(): Promise<string> {
  return canonicalProjectPath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-durability-')));
}

function noopMigrations(): TaskMigrations {
  return {
    runLegacyOnce: async () => {},
    runFirstTouch: async () => {},
  } as unknown as TaskMigrations;
}

function fakeIndex(): ProjectsIndex {
  return {
    loadKnownProjects: async () => {},
    has: () => true,
    add: () => {},
    remove: () => false,
    persistKnownProjects: async () => {},
    values: () => [][Symbol.iterator](),
  } as unknown as ProjectsIndex;
}

async function sidecars(file: string): Promise<string[]> {
  const base = path.basename(file);
  return (await fs.readdir(path.dirname(file))).filter((f) => f.startsWith(`${base}.corrupt-`));
}

test('a tasks.json that parses but is not an array is preserved, not overwritten by the next create', async () => {
  const project = await tmpProject();
  const file = projectTasksFile(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bad = JSON.stringify({ tasks: [{ id: 't_keep', title: 'precious' }] });
  await fs.writeFile(file, bad);

  const cache = new TaskCacheManager({ projectsIndex: fakeIndex(), migrations: noopMigrations() });
  assert.deepEqual(await cache.listTasks(project), []);
  await cache.createTask(project, 'new');
  await cache.flushPersist(project);

  const kept = await sidecars(file);
  assert.equal(kept.length, 1, 'the non-array DB was moved aside');
  assert.equal(await fs.readFile(path.join(path.dirname(file), kept[0]), 'utf8'), bad);
});

test('boot restore does not roll tasks.json back when it merely failed to read', async () => {
  const project = await tmpProject();
  const file = projectTasksFile(project);
  const backup = projectTasksBackupFile(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(backup, JSON.stringify([{ id: 'old' }]));
  // A directory where the file should be: readFile fails with a non-ENOENT
  // code, standing in for a transient Windows EBUSY/EPERM share lock.
  await fs.mkdir(file);
  await restoreTasksFromBackupIfMissing(project, noopMigrations());
  assert.ok((await fs.stat(file)).isDirectory(), 'nothing was restored over it');
  assert.deepEqual(await sidecars(file), []);
});

test('boot restore preserves a corrupt tasks.json before restoring the backup over it', async () => {
  const project = await tmpProject();
  const file = projectTasksFile(project);
  const backup = projectTasksBackupFile(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(backup, JSON.stringify([{ id: 'from-backup' }]));
  await fs.writeFile(file, '[{"id":"newer","ti');
  await restoreTasksFromBackupIfMissing(project, noopMigrations());
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ id: 'from-backup' }]);
  const kept = await sidecars(file);
  assert.equal(kept.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(file), kept[0]), 'utf8'), '[{"id":"newer","ti');
});

test('boot restore treats a non-array tasks.json as corrupt', async () => {
  const project = await tmpProject();
  const file = projectTasksFile(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(projectTasksBackupFile(project), JSON.stringify([{ id: 'b' }]));
  await fs.writeFile(file, 'null');
  await restoreTasksFromBackupIfMissing(project, noopMigrations());
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ id: 'b' }]);
});

test('first-touch migration leaves a backup-only home dir alone so recovery can restore it', async () => {
  const project = await tmpProject();
  const legacy = path.join(project, '.lattice', 'tasks.json');
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(legacy, JSON.stringify([{ id: 'ancient' }]));
  const backup = projectTasksBackupFile(project);
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(backup, JSON.stringify([{ id: 'recent' }]));

  await migrateInProjectTasksToHome(project);
  assert.deepEqual(JSON.parse(await fs.readFile(backup, 'utf8')), [{ id: 'recent' }]);
  await assert.rejects(fs.access(projectTasksFile(project)), { code: 'ENOENT' });

  // And the real boot path then restores the RECENT backup.
  await restoreTasksFromBackupIfMissing(project, new TaskMigrations(fakeIndex()));
  assert.deepEqual(JSON.parse(await fs.readFile(projectTasksFile(project), 'utf8')), [{ id: 'recent' }]);
});

test('first-touch migration still copies a legacy file into a fresh home dir', async () => {
  const project = await tmpProject();
  const legacy = path.join(project, '.lattice', 'tasks.json');
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(legacy, JSON.stringify([{ id: 'l' }]));
  await migrateInProjectTasksToHome(project);
  assert.deepEqual(JSON.parse(await fs.readFile(projectTasksFile(project), 'utf8')), [{ id: 'l' }]);
});

test('global legacy migration skips path-less rows and sets the file aside when a project fails', async () => {
  const good = await tmpProject();
  const broken = await tmpProject();
  // The broken project's existing DB is not a task array: its rows must not
  // be merged over it, and must not be lost with the legacy file either.
  const brokenFile = projectTasksFile(broken);
  await fs.mkdir(path.dirname(brokenFile), { recursive: true });
  await fs.writeFile(brokenFile, '{}');
  await fs.mkdir(path.dirname(LEGACY_GLOBAL_TASKS), { recursive: true });
  const rows = [
    { id: 'a', projectPath: good },
    { id: 'b', projectPath: broken },
    { id: 'c' },
  ];
  await fs.writeFile(LEGACY_GLOBAL_TASKS, JSON.stringify(rows));

  await migrateLegacy(fakeIndex());

  assert.deepEqual(
    JSON.parse(await fs.readFile(projectTasksFile(good), 'utf8')).map((t: { id: string }) => t.id),
    ['a'],
  );
  assert.equal(await fs.readFile(brokenFile, 'utf8'), '{}', 'the unreadable DB was not replaced');
  await assert.rejects(fs.access(LEGACY_GLOBAL_TASKS), { code: 'ENOENT' });
  const aside = (await fs.readdir(path.dirname(LEGACY_GLOBAL_TASKS))).filter((f) =>
    f.startsWith('tasks.json.unmigrated-'),
  );
  assert.equal(aside.length, 1, 'the legacy file was set aside, not deleted');
  for (const f of aside) await fs.rm(path.join(path.dirname(LEGACY_GLOBAL_TASKS), f));
});

test('a task created just before process.exit() is on disk', async () => {
  const project = await tmpProject();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-exitflush-home-'));
  try {
    const managerUrl = pathToFileURL(path.resolve('src/taskCache/manager.ts')).href;
    const script = path.join(home, 'child.mts');
    fsSync.writeFileSync(
      script,
      `import { TaskCacheManager } from ${JSON.stringify(managerUrl)};\n` +
        `const index = { loadKnownProjects: async () => {}, has: () => true, add: () => {},\n` +
        `  remove: () => false, persistKnownProjects: async () => {}, values: () => [][Symbol.iterator]() };\n` +
        `const migrations = { runLegacyOnce: async () => {}, runFirstTouch: async () => {} };\n` +
        `const cache = new TaskCacheManager({ projectsIndex: index, migrations });\n` +
        `await cache.createTask(${JSON.stringify(project)}, 'last words');\n` +
        `process.exit(0);\n`,
    );
    const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(home, '.lattice', path.relative(path.join(os.homedir(), '.lattice'), projectTasksFile(project)));
    const tasks = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(tasks.map((t: { title: string }) => t.title), ['last words']);
    const temps = (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(temps, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
