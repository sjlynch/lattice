import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigReloader } from '../health/configReloader.js';

async function makeProject(layout: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-config-reloader-'));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return dir;
}

const ROOT_ALIAS = JSON.stringify({
  compilerOptions: { paths: { '@root/*': ['src/*'] } },
});
const NESTED_ALIAS = JSON.stringify({
  compilerOptions: { paths: { '@nested/*': ['lib/*'] } },
});

test('reloadForPath fires (and reloads aliases) for the root tsconfig', async () => {
  const dir = await makeProject({ 'tsconfig.json': ROOT_ALIAS });
  const reloader = await ConfigReloader.create(dir);

  const fired = await reloader.reloadForPath(path.join(dir, 'tsconfig.json'));
  assert.equal(fired, true, 'root tsconfig change triggers a config reload');
  assert.ok(
    reloader.aliases.some((a) => a.prefix === '@root/'),
    'root aliases are loaded',
  );
});

test('reloadForPath ignores a nested tsconfig (no rescan, root aliases untouched)', async () => {
  const dir = await makeProject({
    'tsconfig.json': ROOT_ALIAS,
    // A nested tsconfig the watcher can also see — editing it must NOT trigger
    // the full-rescan path nor swap in a different alias map.
    'frontend/tsconfig.app.json': NESTED_ALIAS,
    'backend/tsconfig.json': NESTED_ALIAS,
  });
  const reloader = await ConfigReloader.create(dir);
  const aliasesBefore = reloader.aliases;

  for (const nested of [
    path.join(dir, 'frontend', 'tsconfig.app.json'),
    path.join(dir, 'backend', 'tsconfig.json'),
  ]) {
    const fired = await reloader.reloadForPath(nested);
    assert.equal(fired, false, `nested tsconfig ${nested} does not trigger a rescan`);
  }

  // Same array reference: reloadForPath never called loadProjectAliases.
  assert.equal(reloader.aliases, aliasesBefore, 'root aliases are not reloaded');
});

test('reloadAliasesForNestedTsconfig picks up a nested tsconfig paths edit', async () => {
  const dir = await makeProject({
    'tsconfig.json': ROOT_ALIAS,
    'frontend/tsconfig.app.json': '{}',
  });
  const reloader = await ConfigReloader.create(dir);
  assert.ok(!reloader.aliases.some((a) => a.prefix === '@nested/'));

  // Root tsconfig and non-tsconfig files are not this method's job.
  assert.equal(await reloader.reloadAliasesForNestedTsconfig(path.join(dir, 'tsconfig.json')), false);
  assert.equal(await reloader.reloadAliasesForNestedTsconfig(path.join(dir, 'frontend', 'a.ts')), false);
  assert.equal(
    await reloader.reloadAliasesForNestedTsconfig(path.join(path.dirname(dir), 'elsewhere', 'tsconfig.json')),
    false,
  );

  const nested = path.join(dir, 'frontend', 'tsconfig.app.json');
  await fs.writeFile(nested, NESTED_ALIAS, 'utf8');
  assert.equal(await reloader.reloadAliasesForNestedTsconfig(nested), true);
  assert.ok(reloader.aliases.some((a) => a.prefix === '@nested/'), 'nested alias is live');
  assert.ok(reloader.aliases.some((a) => a.prefix === '@root/'), 'root alias kept');
});

test('reloadForPath ignores a non-root .gitignore but fires for the root one', async () => {
  const dir = await makeProject({
    '.gitignore': 'dist/\n',
    'frontend/.gitignore': 'foo/\n',
  });
  const reloader = await ConfigReloader.create(dir);

  assert.equal(
    await reloader.reloadForPath(path.join(dir, 'frontend', '.gitignore')),
    false,
    'nested .gitignore does not trigger a reload',
  );
  assert.equal(
    await reloader.reloadForPath(path.join(dir, '.gitignore')),
    true,
    'root .gitignore triggers a reload',
  );
});
