import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { parseOpengrepJson, type DigestFilter } from '../opengrep/digest.js';
import { buildOpengrepGraph } from '../opengrep/graph.js';
import type { OpengrepScanRecord } from '../opengrep/scanRecords.js';
import { projectScansDir } from '../opengrep/paths.js';
import { canonicalProjectPath } from '../projectPath.js';
import { buildOpengrepRouter } from '../routes/opengrep.js';

// Graph coverage comes from the visited paths, never from an absence of
// findings. Color counts use every filtered occurrence, without markdown caps.
const filter: DigestFilter = { severityFloor: 'INFO', ignoreRuleIds: [], ignoreFingerprints: [] };
const root = path.resolve('graph-fixture');
const record: OpengrepScanRecord = {
  id: 'og_graph_test', project: root, startedAt: 100, finishedAt: 1350, durationMs: 1250,
  engine: { version: '1.30.0', source: 'path' }, packIds: [], rulePaths: [], targets: [root],
  exitCode: 0, findings: 0, bySeverity: { ERROR: 0, WARNING: 0, INFO: 0 },
  scannedFiles: 0, errors: 0, partiallyParsed: 0, jsonFile: '',
};
function finding(file: string, severity: string, fingerprint: string, rule = 'security.rule') {
  return { path: file, check_id: rule, start: { line: 1 }, extra: { severity, fingerprint } };
}

test('graph uses per-file highest severity, deduplicates, and respects the project filter', () => {
  const parsed = parseOpengrepJson({
    paths: { scanned: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'clean.json', 'ignored.ts'] },
    results: [
      finding('src/a.ts', 'WARNING', 'a-warning'), finding('src/a.ts', 'ERROR', 'a-error'),
      finding('src/a.ts', 'ERROR', 'a-error'), finding('src/b.ts', 'WARNING', 'b-warning'),
      finding('src/c.ts', 'INFO', 'c-info'), finding('ignored.ts', 'ERROR', 'ignored', 'security.ignore'),
    ],
  }, root);
  const graph = buildOpengrepGraph(parsed, record, { ...filter, ignoreRuleIds: ['ignore'] });
  const files = new Map(graph.files.map((f) => [f.path, f]));
  assert.equal(graph.shown, 4);
  assert.equal(files.get('src/a.ts')?.severity, 'ERROR');
  assert.equal(files.get('src/a.ts')?.findings, 2);
  assert.equal(files.get('src/b.ts')?.severity, 'WARNING', 'another file in the same rule group stays WARNING');
  assert.equal(files.get('src/c.ts')?.severity, 'INFO');
  assert.deepEqual(files.get('clean.json'), { path: 'clean.json', severity: null, findings: 0, incomplete: false });
  assert.equal(files.get('ignored.ts')?.severity, null);
  const filtered = buildOpengrepGraph(parsed, record, {
    severityFloor: 'WARNING', ignoreRuleIds: ['ignore'], ignoreFingerprints: ['a-error'],
  });
  assert.equal(filtered.shown, 2);
  assert.equal(filtered.files.find((f) => f.path === 'src/a.ts')?.severity, 'WARNING');
  assert.equal(filtered.files.find((f) => f.path === 'src/c.ts')?.severity, null);
});

test('only visited, completely scanned paths may appear clean', () => {
  const parsed = parseOpengrepJson({
    paths: { scanned: [path.join(root, 'clean.ts'), './partial.ts', 'timeout.ts'] },
    results: [finding('unvisited.ts', 'ERROR', 'error')],
    errors: [
      { type: ['PartialParsing'], path: './partial.ts' },
      { type: 'Timeout', path: 'timeout.ts' },
    ],
  }, root);
  assert.deepEqual(parsed.scannedPaths, ['clean.ts', 'partial.ts', 'timeout.ts']);
  const files = buildOpengrepGraph(parsed, record, filter).files;
  assert.equal(files.find((f) => f.path === 'clean.ts')?.incomplete, false);
  for (const p of ['partial.ts', 'timeout.ts', 'unvisited.ts']) {
    assert.equal(files.find((f) => f.path === p)?.incomplete, true, p);
  }
  assert.equal(files.find((f) => f.path === 'unvisited.ts')?.severity, 'ERROR');
  assert.equal(files.find((f) => f.path === 'not-in-output.ts'), undefined);
  for (const incomplete of [
    { ...parsed, skippedRules: 1 },
    { ...parsed, errors: [{ kind: 'EngineError', level: 'error', message: 'failed' }] },
  ]) {
    assert.ok(buildOpengrepGraph(incomplete, record, filter).files.every((f) => f.incomplete));
  }
  for (const exitCode of [null, 2]) {
    assert.ok(buildOpengrepGraph(parsed, { ...record, exitCode }, filter).files.every((f) => f.incomplete));
  }
});

test('graph colors only the occurrence that survived filtering before deduplication', () => {
  const parsed = parseOpengrepJson({
    paths: { scanned: ['below-floor.ts', 'shown.ts'] },
    results: [finding('below-floor.ts', 'INFO', 'same-fingerprint'), finding('shown.ts', 'ERROR', 'same-fingerprint')],
  }, root);
  const graph = buildOpengrepGraph(parsed, record, { ...filter, severityFloor: 'WARNING' });
  assert.equal(graph.shown, 1);
  assert.equal(graph.files.find((f) => f.path === 'below-floor.ts')?.severity, null);
  assert.equal(graph.files.find((f) => f.path === 'shown.ts')?.severity, 'ERROR');
});

test('all files are represented even when a rule exceeds the markdown per-group cap', () => {
  const names = Array.from({ length: 70 }, (_, i) => `src/${i}.ts`);
  const parsed = parseOpengrepJson({ paths: { scanned: names }, results: names.map((p, i) => finding(p, 'ERROR', `fp-${i}`)) }, root);
  const graph = buildOpengrepGraph(parsed, record, filter);
  assert.equal(graph.shown, 70);
  assert.equal(graph.files.length, 70);
  assert.ok(graph.files.every((f) => f.severity === 'ERROR' && f.findings === 1));
});

test('format=graph serves a stored scan with coverage and the normal severity floor', async (t) => {
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'stored-scan fixture requires isolated HOME');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-security-graph-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const canonical = canonicalProjectPath(project);
  const dir = projectScansDir(canonical);
  await fs.mkdir(dir, { recursive: true });
  const meta = { ...record, project: canonical, jsonFile: path.join(dir, `${record.id}.json`) };
  await fs.writeFile(meta.jsonFile, JSON.stringify({ paths: { scanned: ['app.ts', 'clean.json'] },
    results: [finding('app.ts', 'ERROR', 'error'), finding('app.ts', 'INFO', 'info')] }));
  await fs.writeFile(path.join(dir, `${record.id}.meta.json`), JSON.stringify(meta));
  const app = express();
  app.use(buildOpengrepRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const params = new URLSearchParams({ project, format: 'graph' });
  const response = await fetch(`${base}/api/opengrep/scans/${record.id}?${params}`);
  assert.equal(response.status, 200);
  const graph = await response.json() as ReturnType<typeof buildOpengrepGraph>;
  assert.equal(graph.canonicalProject, canonical);
  assert.equal(graph.scan.id, record.id);
  assert.equal(graph.shown, 1, 'INFO is below the default WARNING floor');
  assert.equal(graph.files.find((f) => f.path === 'app.ts')?.severity, 'ERROR');
  assert.equal(graph.files.find((f) => f.path === 'clean.json')?.incomplete, false);
  assert.equal((await fetch(`${base}/api/opengrep/scans/og_missing?${params}`)).status, 404);
});
