import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOpengrepScan, readOpengrepScan, listOpengrepScans, OpengrepScanAbortedError } from '../opengrep/scan.js';
import { reusablePaths, changedPaths, captureScanInputs } from '../opengrep/scanCache.js';
import { buildOpengrepGraph } from '../opengrep/graph.js';
import { DEFAULT_DIGEST_FILTER } from '../opengrep/digest.js';

if (!process.env.LATTICE_TEST_HOME_ISOLATED) throw new Error('Run with helpers/isolateHome.mjs');
const engine = { command: 'fake-opengrep', source: 'path' as const, version: '1.30.0' };

test('incremental snapshots replace changed findings, retain clean coverage, drop deletions, and invalidate on rule changes', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-opengrep-cache-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, '.opengrep', 'rules'), { recursive: true });
  const rules = path.join(project, '.opengrep', 'rules', 'r.yaml');
  await fs.writeFile(rules, 'rules: []');
  await fs.writeFile(path.join(project, 'a.ts'), 'SECRET');
  await fs.writeFile(path.join(project, 'b.ts'), 'SECRET');
  await fs.writeFile(path.join(project, 'clean.ts'), 'clean');
  const calls: string[][] = [];
  let editDuringScan = false;
  const spawn = async (_command: string, args: string[]) => {
    calls.push(args);
    const includes = args.filter((arg) => arg.startsWith('--include=')).map((arg) => arg.slice('--include=**/'.length));
    const selected = (await fs.readdir(project)).filter((file) => file.endsWith('.ts') && (!includes.length || includes.includes(file)));
    const results = [];
    for (const file of selected) {
      const code = await fs.readFile(path.join(project, file), 'utf8');
      if (code.includes('SECRET')) results.push({ check_id: 'test.security.secret', path: path.join(project, file), start: { line: 1, col: 1 }, end: { line: 1 },
        extra: { fingerprint: `${file}_0`, message: 'Secret', severity: 'ERROR', lines: code, metadata: { category: 'security' } } });
    }
    if (editDuringScan) await fs.writeFile(path.join(project, 'a.ts'), 'new edit during scan');
    await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ version: '1.30.0', results, paths: { scanned: selected.map((f) => path.join(project, f)) }, errors: [] }));
    return { code: 0, stdout: '', stderr: '', combined: '', timedOut: false, error: null };
  };
  const deps = { resolve: async () => engine, spawn };
  const request = { project, packIds: [], mode: 'full' as const };
  const first = await runOpengrepScan(request, deps);
  assert.equal(first.findings, 2);
  assert.equal(first.scannedFiles, 3);
  await fs.writeFile(path.join(project, 'a.ts'), 'fixed');
  const update = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  assert.deepEqual(calls[1].filter((arg) => arg.startsWith('--include=')), ['--include=**/a.ts']);
  assert.equal(update.update?.mode, 'incremental');
  assert.equal(update.update?.reusedFiles, 2);
  assert.equal(update.findings, 1);
  const stored = (await readOpengrepScan(project, update.id))!;
  assert.deepEqual(stored.parsed.findings.map((f) => f.path), ['b.ts']);
  assert.equal(buildOpengrepGraph(stored.parsed, update, DEFAULT_DIGEST_FILTER).files.find((f) => f.path === 'a.ts')?.incomplete, false);
  const noChange = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  assert.equal(calls.length, 2, 'no changed inputs means no engine process');
  assert.equal(noChange.update?.reusedFiles, 3);
  assert.equal(noChange.findings, 1);
  await fs.rename(path.join(project, 'b.ts'), path.join(project, 'renamed.ts'));
  const rename = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  const renamed = (await readOpengrepScan(project, rename.id))!;
  assert.deepEqual(renamed.parsed.findings.map((f) => f.path), ['renamed.ts']);
  assert.equal(renamed.parsed.scannedPaths.includes('b.ts'), false);
  await fs.writeFile(rules, 'rules: []\n# changed');
  const ruleChange = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  assert.equal(ruleChange.update?.mode, 'full');
  assert.match(ruleChange.update?.reason ?? '', /configuration changed/);
  assert.equal(calls.at(-1)!.some((arg) => arg.startsWith('--include=')), false);
  await fs.writeFile(path.join(project, 'a.ts'), 'SECRET');
  editDuringScan = true;
  const raced = await runOpengrepScan({ ...request, mode: 'incremental' }, deps);
  const racedSnapshot = (await readOpengrepScan(project, raced.id))!;
  assert.equal(racedSnapshot.cache!.reusable.includes('a.ts'), false, 'a mid-scan edit cannot be reused as analyzed');
  const count = (await listOpengrepScans(project)).length;
  const controller = new AbortController();
  await assert.rejects(runOpengrepScan({ ...request, mode: 'incremental', signal: controller.signal }, {
    ...deps, spawn: async () => { controller.abort(); return { code: null, stdout: '', stderr: '', combined: '', timedOut: false, aborted: true, error: null }; },
  }), OpengrepScanAbortedError);
  assert.equal((await listOpengrepScans(project)).length, count, 'cancellation does not promote a partial snapshot');
});

test('incomplete coverage and analysis errors cannot become reusable clean files', () => {
  const before = { configuration: 'same', files: { 'clean.ts': 'a', 'partial.ts': 'b', 'error.ts': 'c', 'edited.ts': 'd' } };
  const after = { ...before, files: { ...before.files, 'edited.ts': 'changed' } };
  const parsed = { version: '1.30.0', findings: [], scannedFiles: 4,
    scannedPaths: Object.keys(before.files), partiallyParsed: ['partial.ts'], skippedRules: 0,
    errors: [{ kind: 'parse', level: 'error', message: 'failed', path: 'error.ts' }] };
  assert.deepEqual(reusablePaths(parsed, 0, before, after), ['clean.ts']);
  assert.deepEqual(reusablePaths({ ...parsed, skippedRules: 1 }, 0, before, after), []);
  assert.deepEqual(reusablePaths({ ...parsed, errors: [{ kind: 'engine', level: 'error', message: 'failed' }] }, 0, before, after), []);
  assert.deepEqual(reusablePaths(parsed, 2, before, after), []);
  assert.deepEqual(reusablePaths(parsed, 0, before, { ...after, configuration: 'changed' }), []);
  assert.deepEqual(changedPaths(before, after), ['edited.ts']);
});

test('ignore contents and git selection changes invalidate analysis; untracked external configuration refuses reuse', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-opengrep-cache-context-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, '.git'));
  await fs.writeFile(path.join(project, '.git', 'config'), '[core]\n');
  await fs.writeFile(path.join(project, '.gitignore'), '*.log\n');
  await fs.writeFile(path.join(project, '__proto__'), 'a valid file name');
  const capture = () => captureScanInputs({ project, engine, rulePaths: [], excludeGlobs: [], targets: ['.'] });
  const initial = await capture();
  assert.equal(typeof initial.files.__proto__, 'string', 'prototype names are ordinary content identities');
  await fs.writeFile(path.join(project, '.gitignore'), '*.txt\n');
  const ignored = await capture();
  assert.notEqual(ignored.configuration, initial.configuration);
  await fs.writeFile(path.join(project, '.git', 'index'), 'newly tracked files');
  assert.notEqual((await capture()).configuration, ignored.configuration);
  await fs.writeFile(path.join(project, '.semgrepignore'), ':include ../external-ignore\n');
  await assert.rejects(capture(), /External ignore/);
  await fs.writeFile(path.join(project, '.semgrepignore'), '');
  await fs.writeFile(path.join(project, '.git', 'config'), '[include]\npath = ../external-config\n');
  await assert.rejects(capture(), /External git configuration/);
});
