import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectsIndex } from '../taskCache/projectsIndex.js';
import { LATTICE_HOME, PROJECTS_INDEX } from '../taskCache/paths.js';

test('a failed index write leaves the existing project recovery index intact', async (t) => {
  await fs.mkdir(LATTICE_HOME, { recursive: true });
  const previous = JSON.stringify(['C:/existing-project']);
  await fs.writeFile(PROJECTS_INDEX, previous, 'utf8');
  const index = new ProjectsIndex();
  index.add('C:/existing-project');
  index.add('C:/new-project');
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(PROJECTS_INDEX)) {
      // A disk-full error or process death can leave any partially-written
      // destination behind. The live index must never be that destination.
      await writeFile(args[0], '["C:', 'utf8');
      throw Object.assign(new Error('simulated partial write'), { code: 'ENOSPC' });
    }
    return writeFile(...args);
  });

  await index.persistKnownProjects();
  assert.equal(await fs.readFile(PROJECTS_INDEX, 'utf8'), previous);
  assert.deepEqual((await fs.readdir(path.dirname(PROJECTS_INDEX))).filter((name) => name.endsWith('.tmp')), []);
});

test('overlapping project registrations cannot persist an older index last', async (t) => {
  const index = new ProjectsIndex();
  index.add('C:/first-project');
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const writeFile = fs.writeFile;
  let first = true;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(PROJECTS_INDEX) && first) {
      first = false;
      enter();
      await held;
    }
    return writeFile(...args);
  });

  const firstPersist = index.persistKnownProjects();
  await entered;
  index.add('C:/second-project');
  const secondPersist = index.persistKnownProjects();
  // Drain any incorrectly parallel second writer before allowing the stale
  // first writer to finish. Serialization must keep that writer waiting.
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  release();
  await Promise.all([firstPersist, secondPersist]);
  assert.deepEqual(JSON.parse(await fs.readFile(PROJECTS_INDEX, 'utf8')), [
    'C:/first-project', 'C:/second-project',
  ]);
});

test('an unreadable index stays protected and a later read retries it', async (t) => {
  await fs.mkdir(LATTICE_HOME, { recursive: true });
  const project = process.cwd(); // Existing directory, inspected only for index pruning.
  const previous = JSON.stringify([project]);
  await fs.writeFile(PROJECTS_INDEX, previous, 'utf8');
  const index = new ProjectsIndex();
  const readFile = fs.readFile;
  let unavailable = true;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === PROJECTS_INDEX && unavailable) {
      throw Object.assign(new Error('index temporarily locked'), { code: 'EACCES' });
    }
    return readFile(...args);
  });

  await assert.rejects(index.loadKnownProjects(), { code: 'EACCES' });
  index.add('C:/new-project');
  await index.persistKnownProjects();
  assert.equal(await readFile(PROJECTS_INDEX, 'utf8'), previous);
  unavailable = false;
  await index.loadKnownProjects();
  assert.ok(index.has(project), 'a later request must retry the previously unread index');
});

for (const previous of ['["C:/recoverable', '{"unexpected":"shape"}']) {
  test(`an invalid project index is never overwritten: ${previous}`, async () => {
    await fs.mkdir(LATTICE_HOME, { recursive: true });
    await fs.writeFile(PROJECTS_INDEX, previous, 'utf8');
    const index = new ProjectsIndex();
    await assert.rejects(index.loadKnownProjects());
    index.add('C:/new-project');
    await index.persistKnownProjects();
    assert.equal(await fs.readFile(PROJECTS_INDEX, 'utf8'), previous);
  });
}
