// Optional integration check against the user's installed binary, with a tiny
// authored rule and an isolated HOME/project. Never downloads or scans Lattice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runOpengrepScan, readOpengrepScan } from '../opengrep/scan.js';
import { spawnWithTimeout } from '../spawnWithTimeout.js';

test('real engine include filters preserve a full scan snapshot and project exclusions', { skip: !process.env.LATTICE_TEST_OPENGREP_BINARY }, async (t) => {
  if (!process.env.LATTICE_TEST_HOME_ISOLATED) throw new Error('Use helpers/isolateHome.mjs');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-opengrep-real-cache-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, '.opengrep', 'rules'), { recursive: true });
  await fs.mkdir(path.join(project, 'src'));
  await fs.writeFile(path.join(project, '.opengrep', 'rules', 'test.yaml'), 'rules:\n  - id: cache-test-eval\n    languages: [javascript]\n    severity: ERROR\n    message: Avoid eval\n    pattern: eval($X)\n');
  await fs.writeFile(path.join(project, 'src', 'UpperCase.js'), 'eval("a");\n');
  await fs.writeFile(path.join(project, 'src', 'b.js'), 'eval("b");\n');
  await fs.writeFile(path.join(project, 'src', 'clean.js'), 'const x = 1;\n');
  await fs.writeFile(path.join(project, 'src', 'ignored.js'), 'eval("ignored");\n');
  await fs.writeFile(path.join(project, '.semgrepignore'), 'src/ignored.js\n');
  // Exercise real git target selection as well as the file/rule hashes.
  await promisify(execFile)('git', ['init'], { cwd: project, windowsHide: true });
  await promisify(execFile)('git', ['add', '.'], { cwd: project, windowsHide: true });
  const deps = { resolve: async () => ({ command: process.env.LATTICE_TEST_OPENGREP_BINARY!, source: 'path' as const, version: '1.30.0' }),
    // The Windows runtime crashes even on --version with an unregistered
    // USERPROFILE. Keep Lattice's HOME isolated and only restore the child's
    // registered Windows profile when supplied by the integration-test caller.
    spawn: (command: string, args: string[], opts: Parameters<typeof spawnWithTimeout>[2]) => spawnWithTimeout(command, args, {
      ...opts, env: { ...process.env,
        ...(process.env.LATTICE_TEST_OPENGREP_USERPROFILE ? { USERPROFILE: process.env.LATTICE_TEST_OPENGREP_USERPROFILE } : {}),
        SEMGREP_SETTINGS_FILE: path.join(os.homedir(), 'semgrep-test-settings.yml'),
      },
    }),
  };
  const request = { project, packIds: [], mode: 'full' as const, jobs: 1, excludeGlobs: ['**/ignored.js'] };
  const full = await runOpengrepScan(request, deps);
  assert.equal(full.findings, 2, 'the ignored eval is excluded');
  await fs.writeFile(path.join(project, 'src', 'UpperCase.js'), 'const fixed = 1;\n');
  const update = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  assert.equal(update.findings, 1);
  assert.equal(update.update?.mode, 'incremental');
  assert.equal(update.update?.analyzedFiles, 1);
  const stored = (await readOpengrepScan(project, update.id))!;
  assert.deepEqual(stored.parsed.findings.map((f) => f.path), ['src/b.js']);
  assert.ok(stored.parsed.scannedPaths.includes('src/UpperCase.js'));
  assert.ok(stored.parsed.scannedPaths.includes('src/clean.js'));
  await fs.writeFile(path.join(project, 'src', 'ignored.js'), 'eval("still ignored");\n');
  const ignoredUpdate = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  assert.equal(ignoredUpdate.findings, 1, 'include patterns do not bypass project ignores');
  const zero = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  assert.equal(zero.update?.analyzedFiles, 0);
  assert.equal(zero.findings, 1);
});
