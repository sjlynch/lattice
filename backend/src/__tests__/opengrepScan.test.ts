import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpengrepBadTargetError,
  OpengrepNoRulesError,
  OpengrepNotInstalledError,
  OpengrepScanAbortedError,
  OpengrepScanBusyError,
  OpengrepScanFailedError,
  abortOpengrepScan,
  buildScanArgs,
  defaultScanJobs,
  isAnyOpengrepScanRunning,
  listOpengrepScans,
  readOpengrepScan,
  resolveScanTargets,
  runOpengrepScan,
} from '../opengrep/scan.js';
import { rulePackDir, rulesRootDir, projectScansDir } from '../opengrep/paths.js';
import { updateOpengrepState } from '../opengrep/state.js';
import type { SpawnWithTimeoutResult } from '../spawnWithTimeout.js';

// The scan runner around a FAKE engine: the spawn seam receives the exact
// command line and cwd Lattice would use and writes the fixture JSON to the
// `-o` path. HOME is the suite's throwaway (isolateHome.mjs), so the rules
// root / state.json / per-project scan dir all land in temp.

// This file writes a FAKE rule pack + state.json under ~/.lattice/opengrep/.
// Refuse to run against a real home: `npm test` preloads helpers/isolateHome.mjs.
if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error(
    'opengrepScan.test.ts writes under ~/.lattice — run it via `npm test` (or with ' +
      '`--import ./src/__tests__/helpers/isolateHome.mjs`), never bare `node --test`.',
  );
}

const FIXTURE = fileURLToPath(new URL('./fixtures/opengrep-scan.json', import.meta.url));
const ENGINE = { command: 'C:\\fake\\opengrep.exe', source: 'path' as const, version: '1.30.0' };

type SpawnCall = { command: string; args: string[]; cwd?: string };

function fakeSpawn(calls: SpawnCall[], opts: { code?: number; write?: boolean; delayMs?: number } = {}) {
  return async (command: string, args: string[], o: { cwd?: string; timeoutMs: number }): Promise<SpawnWithTimeoutResult> => {
    calls.push({ command, args, cwd: o.cwd });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.write !== false) {
      const out = args[args.indexOf('-o') + 1];
      await fs.copyFile(FIXTURE, out);
    }
    return { code: opts.code ?? 0, stdout: '', stderr: opts.write === false ? 'boom' : '', combined: '', timedOut: false, error: null };
  };
}

async function installFakePack(id = 'qodana-mit'): Promise<void> {
  await fs.mkdir(rulePackDir(id), { recursive: true });
  await fs.writeFile(path.join(rulePackDir(id), 'r.yaml'), 'rules: []\n');
  await updateOpengrepState((s) => ({
    ...s,
    packs: { ...s.packs, [id]: { commit: 'x', ruleFiles: 1, ruleCount: 0, licence: 'MIT', installedAt: 1 } },
  }));
}

async function withProject<T>(fn: (project: string) => Promise<T>): Promise<T> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-opengrep-scan-'));
  try {
    return await fn(project);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
}

test('buildScanArgs + defaultScanJobs', () => {
  const args = buildScanArgs({ rulePaths: ['qodana-mit', 'C:\\p\\.opengrep\\rules'], excludeGlobs: ['dist'], jobs: 4, outFile: 'out.json', targets: ['C:\\p'] });
  assert.deepEqual(args.slice(0, 3), ['scan', '--json', '--quiet']);
  assert.ok(args.includes('--jobs=4'));
  assert.ok(args.includes('--exclude=dist'));
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 4), ['-f', 'qodana-mit', '-f', 'C:\\p\\.opengrep\\rules']);
  assert.deepEqual(args.slice(-3), ['-o', 'out.json', 'C:\\p']);
  assert.equal(defaultScanJobs(8), 6);
  assert.equal(defaultScanJobs(2), 1);
  assert.equal(defaultScanJobs(1), 1);
});

test('a scan runs from the rules root with the pack as a relative config, stores the record and the raw JSON', async () => {
  await installFakePack();
  await withProject(async (project) => {
    const calls: SpawnCall[] = [];
    const record = await runOpengrepScan(
      { project, packIds: ['qodana-mit', 'opengrep-archived'], excludeGlobs: ['gen/**'], jobs: 3 },
      { resolve: async () => ENGINE, spawn: fakeSpawn(calls) },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, ENGINE.command);
    assert.equal(calls[0].cwd, rulesRootDir(), 'cwd is the rules root (stable check ids / fingerprints)');
    const args = calls[0].args;
    assert.ok(args.includes('--jobs=3'));
    assert.ok(args.includes('--exclude=gen/**'));
    assert.ok(args.includes('--exclude=node_modules'), 'default excludes ride along');
    assert.deepEqual(args.filter((_, i) => args[i - 1] === '-f'), ['qodana-mit'], 'only INSTALLED packs are passed');
    assert.equal(args[args.length - 1].toLowerCase(), record.project.toLowerCase(), 'the target is the canonical project');

    assert.deepEqual(record.packIds, ['qodana-mit']);
    assert.equal(record.findings, 32);
    assert.deepEqual(record.bySeverity, { ERROR: 7, WARNING: 13, INFO: 12 });
    assert.equal(record.scannedFiles, 40);
    assert.equal(record.engine.version, '1.30.0');
    assert.ok(record.jsonFile.startsWith(projectScansDir(record.project)));

    const listed = await listOpengrepScans(project);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, record.id);
    const stored = await readOpengrepScan(project, record.id);
    assert.ok(stored);
    assert.equal(stored.parsed.findings.length, 32);
    assert.equal(await readOpengrepScan(project, '../../etc'), null, 'ids are validated');
  });
});

test('the project-local .opengrep/rules dir is always loaded when present', async () => {
  await installFakePack();
  await withProject(async (project) => {
    const own = path.join(project, '.opengrep', 'rules');
    await fs.mkdir(own, { recursive: true });
    const calls: SpawnCall[] = [];
    const record = await runOpengrepScan(
      { project, packIds: ['qodana-mit'] },
      { resolve: async () => ENGINE, spawn: fakeSpawn(calls) },
    );
    const configs = calls[0].args.filter((_, i) => calls[0].args[i - 1] === '-f');
    assert.equal(configs.length, 2);
    assert.ok(configs[1].toLowerCase().endsWith(path.join('.opengrep', 'rules').toLowerCase()));
    assert.equal(record.rulePaths.length, 2);
  });
});

test('one scan per project: a concurrent request is refused with OpengrepScanBusyError', async () => {
  await installFakePack();
  await withProject(async (project) => {
    const calls: SpawnCall[] = [];
    const deps = { resolve: async () => ENGINE, spawn: fakeSpawn(calls, { delayMs: 150 }) };
    assert.equal(isAnyOpengrepScanRunning(), false);
    const first = runOpengrepScan({ project, packIds: ['qodana-mit'] }, deps);
    assert.equal(isAnyOpengrepScanRunning(), true, 'the pack routes see a scan in flight');
    await assert.rejects(runOpengrepScan({ project, packIds: ['qodana-mit'] }, deps), OpengrepScanBusyError);
    await first;
    assert.equal(isAnyOpengrepScanRunning(), false);
    // …and the slot frees once it settles.
    await runOpengrepScan({ project, packIds: ['qodana-mit'] }, deps);
    assert.equal(calls.length, 2);
  });
});

test('abortOpengrepScan kills the running scan, frees the busy slot at once, and stores nothing', async () => {
  await installFakePack();
  await withProject(async (project) => {
    const calls: SpawnCall[] = [];
    // A fake engine that only returns once the caller's signal fires.
    const spawn = async (command: string, args: string[], o: { cwd?: string; timeoutMs: number; signal?: AbortSignal }): Promise<SpawnWithTimeoutResult> => {
      calls.push({ command, args, cwd: o.cwd });
      await new Promise<void>((r) => o.signal!.addEventListener('abort', () => r(), { once: true }));
      return { code: null, stdout: '', stderr: '', combined: '', timedOut: false, aborted: true, error: null };
    };
    const deps = { resolve: async () => ENGINE, spawn };
    const scan = runOpengrepScan({ project, packIds: ['qodana-mit'] }, deps);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(isAnyOpengrepScanRunning(), true);
    assert.equal(abortOpengrepScan(project), true);
    await assert.rejects(scan, OpengrepScanAbortedError);
    assert.equal(isAnyOpengrepScanRunning(), false, 'the slot frees when the abort settles');
    assert.equal(abortOpengrepScan(project), false, 'nothing left to abort');
    assert.deepEqual(await listOpengrepScans(project), [], 'no record for a cancelled scan');
    assert.equal(calls.length, 1);

    // A caller-supplied signal works the same way.
    const ctrl = new AbortController();
    const second = runOpengrepScan({ project, packIds: ['qodana-mit'], signal: ctrl.signal }, deps);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    await assert.rejects(second, OpengrepScanAbortedError);
    // …and a scan can run again afterwards.
    await runOpengrepScan({ project, packIds: ['qodana-mit'] }, { resolve: async () => ENGINE, spawn: fakeSpawn(calls) });
    assert.equal((await listOpengrepScans(project)).length, 1);
  });
});

test('targets are confined to the project: relative sub-paths resolve, escapes are refused, "." subsumes the rest', async () => {
  const project = 'C:\\proj';
  const inside = resolveScanTargets(project, ['backend/src', './frontend\\src', 'backend/src']);
  assert.deepEqual(inside.rel, ['backend/src', 'frontend/src'], 'normalized, deduplicated, forward slashes');
  assert.deepEqual(inside.abs.map((p) => p.toLowerCase()), [
    path.resolve(project, 'backend/src').toLowerCase(),
    path.resolve(project, 'frontend/src').toLowerCase(),
  ]);
  assert.deepEqual(resolveScanTargets(project, undefined), { abs: [project], rel: ['.'] });
  assert.deepEqual(resolveScanTargets(project, ['backend', '.']), { abs: [project], rel: ['.'] });
  assert.throws(() => resolveScanTargets(project, ['../other']), OpengrepBadTargetError);
  assert.throws(() => resolveScanTargets(project, ['..']), OpengrepBadTargetError);
  assert.deepEqual(resolveScanTargets(project, ['..dots']).rel, ['..dots'], 'a subdir named ..dots is inside');
  assert.throws(() => resolveScanTargets(project, ['backend/../../other']), OpengrepBadTargetError);
  assert.throws(() => resolveScanTargets(project, ['D:\\elsewhere']), OpengrepBadTargetError);

  // Through the runner: refused before the engine is even resolved.
  await installFakePack();
  await withProject(async (p) => {
    const calls: SpawnCall[] = [];
    await assert.rejects(
      runOpengrepScan({ project: p, packIds: ['qodana-mit'], targets: ['..'] }, { resolve: async () => ENGINE, spawn: fakeSpawn(calls) }),
      OpengrepBadTargetError,
    );
    assert.equal(calls.length, 0);
    const record = await runOpengrepScan(
      { project: p, packIds: ['qodana-mit'], targets: ['src/'] },
      { resolve: async () => ENGINE, spawn: fakeSpawn(calls) },
    );
    assert.deepEqual(record.targets, ['src']);
    assert.equal(calls[0].args[calls[0].args.length - 1].toLowerCase(), path.join(record.project, 'src').toLowerCase());
  });
});

test('missing engine / no rules / engine failure each surface as their own error, leaving no half-written scan', async () => {
  await withProject(async (project) => {
    await assert.rejects(
      runOpengrepScan({ project, packIds: ['qodana-mit'] }, { resolve: async () => null, spawn: fakeSpawn([]) }),
      OpengrepNotInstalledError,
    );
    await assert.rejects(
      runOpengrepScan({ project, packIds: ['nope'] }, { resolve: async () => ENGINE, spawn: fakeSpawn([]) }),
      OpengrepNoRulesError,
    );
    await installFakePack();
    await assert.rejects(
      runOpengrepScan(
        { project, packIds: ['qodana-mit'] },
        { resolve: async () => ENGINE, spawn: fakeSpawn([], { code: 2, write: false }) },
      ),
      (err: unknown) => err instanceof OpengrepScanFailedError && /exited 2/.test(err.message) && /boom/.test(err.message),
    );
    assert.deepEqual(await listOpengrepScans(project), []);
  });
});
