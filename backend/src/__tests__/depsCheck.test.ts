import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkWorkspaceDeps,
  declaredDeps,
  describeStaleDep,
  findStaleDeps,
  lockedVersion,
} from '../../../scripts/depsCheck.mjs';

// Regression for: `git pull` brought in a commit that added
// `@modelcontextprotocol/sdk` + `zod` to backend/package.json, `npm run dev`
// passed preflight (which only probed a hand-picked sample of packages), and
// the boot died in the initial `tsc` with "Cannot find module ...". The
// self-heal checks now compare what each workspace DECLARES against what is
// installed, so a new or bumped dependency triggers a reinstall instead.

const manifest = {
  dependencies: { express: '^4.21.2', '@scope/sdk': '^1.30.0' },
  devDependencies: { '@types/node': '^22.10.2', express: '^4.21.2' },
  optionalDependencies: { fsevents: '^2.3.3' },
};

const lockV3 = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'x' },
    'node_modules/express': { version: '4.21.2' },
    'node_modules/@scope/sdk': { version: '1.30.0' },
    'node_modules/@types/node': { version: '22.10.2' },
    'node_modules/linked': { link: true, resolved: '../linked' },
  },
};

function installed(versions: Record<string, string | null>) {
  return (name: string) => (name in versions ? versions[name] : null);
}

test('declaredDeps: deps + devDeps, deduped, optionalDependencies excluded', () => {
  assert.deepEqual(declaredDeps(manifest).sort(), ['@scope/sdk', '@types/node', 'express']);
  assert.deepEqual(declaredDeps(null), []);
  assert.deepEqual(declaredDeps({ dependencies: 'nope' }), []);
});

test('lockedVersion: v2/v3 packages map, v1 dependencies tree, link entries, no lock', () => {
  assert.equal(lockedVersion(lockV3, 'express'), '4.21.2');
  assert.equal(lockedVersion(lockV3, '@scope/sdk'), '1.30.0');
  assert.equal(lockedVersion(lockV3, 'linked'), null);
  assert.equal(lockedVersion(lockV3, 'absent'), null);
  assert.equal(
    lockedVersion({ lockfileVersion: 1, dependencies: { express: { version: '4.0.0' } } }, 'express'),
    '4.0.0',
  );
  assert.equal(lockedVersion(null, 'express'), null);
});

test('findStaleDeps: healthy tree yields nothing', () => {
  const stale = findStaleDeps({
    manifest,
    lock: lockV3,
    installedVersion: installed({ express: '4.21.2', '@scope/sdk': '1.30.0', '@types/node': '22.10.2' }),
  });
  assert.deepEqual(stale, []);
});

test('findStaleDeps: a declared-but-uninstalled dep is flagged missing (the pulled-new-dep case)', () => {
  const stale = findStaleDeps({
    manifest,
    lock: lockV3,
    installedVersion: installed({ express: '4.21.2', '@types/node': '22.10.2' }),
  });
  assert.deepEqual(stale, [{ name: '@scope/sdk', reason: 'missing' }]);
});

test('findStaleDeps: an installed version that differs from the lock is flagged (the pulled-bump case)', () => {
  const stale = findStaleDeps({
    manifest,
    lock: lockV3,
    installedVersion: installed({ express: '4.20.0', '@scope/sdk': '1.30.0', '@types/node': '22.10.2' }),
  });
  assert.deepEqual(stale, [
    { name: 'express', reason: 'version', expected: '4.21.2', installed: '4.20.0' },
  ]);
});

test('findStaleDeps: without a lock pin only presence is checked', () => {
  const stale = findStaleDeps({
    manifest,
    lock: null,
    installedVersion: installed({ express: '1.0.0', '@scope/sdk': '0.0.1', '@types/node': '1' }),
  });
  assert.deepEqual(stale, []);
});

test('describeStaleDep: readable lines with an optional workspace prefix', () => {
  assert.equal(describeStaleDep({ name: 'zod', reason: 'missing' }, 'backend'), 'backend/zod (not installed)');
  assert.equal(
    describeStaleDep({ name: 'zod', reason: 'version', expected: '4.5.4', installed: '3.0.0' }),
    'zod (installed 3.0.0, lockfile wants 4.5.4)',
  );
});

test('checkWorkspaceDeps: reads a real workspace on disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-depscheck-'));
  try {
    const write = (rel: string, obj: unknown) =>
      fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }).then(() =>
        fs.writeFile(path.join(dir, rel), JSON.stringify(obj)),
      );

    await write('package.json', { dependencies: { foo: '^1.0.0', '@scope/bar': '^2.0.0' } });
    await write('package-lock.json', {
      lockfileVersion: 3,
      packages: {
        'node_modules/foo': { version: '1.0.0' },
        'node_modules/@scope/bar': { version: '2.0.0' },
      },
    });
    await write('node_modules/foo/package.json', { name: 'foo', version: '1.0.0' });

    // Scoped dep not installed yet → missing.
    assert.deepEqual(checkWorkspaceDeps(dir), [{ name: '@scope/bar', reason: 'missing' }]);

    // Install it → healthy.
    await write('node_modules/@scope/bar/package.json', { name: '@scope/bar', version: '2.0.0' });
    assert.deepEqual(checkWorkspaceDeps(dir), []);

    // A pulled lock bump → version mismatch until reinstalled.
    await write('package-lock.json', {
      lockfileVersion: 3,
      packages: {
        'node_modules/foo': { version: '1.1.0' },
        'node_modules/@scope/bar': { version: '2.0.0' },
      },
    });
    assert.deepEqual(checkWorkspaceDeps(dir), [
      { name: 'foo', reason: 'version', expected: '1.1.0', installed: '1.0.0' },
    ]);

    // No manifest → nothing declared, nothing to report.
    assert.deepEqual(checkWorkspaceDeps(path.join(dir, 'nope')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
