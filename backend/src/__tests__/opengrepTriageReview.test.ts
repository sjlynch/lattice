import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { withTempDir } from './helpers/tempDir.js';
import { parseOpengrepJson, buildDigest, type DigestFilter } from '../opengrep/digest.js';
import { effectiveDisposition, readTriage, setFindingDisposition, triageFile, validateDisposition, withFindingTriage } from '../opengrep/triage.js';
import { publicReview, readReviewStore, recommendationIsStale, updateReviewStore, validateRecommendations, type ReviewRun } from '../opengrep/reviewStore.js';
import { applyRecommendations, cancelSecurityReview, planRecommendations } from '../opengrep/review.js';
import { finishReview, reviewPaths, startReviewSession } from '../opengrep/reviewSession.js';
import { listTasks } from '../tasks.js';
import { projectScansDir } from '../opengrep/paths.js';
import { buildOpengrepReviewRouter } from '../routes/opengrepReview.js';
import { homeProjectDir } from '../projectPath.js';
import { pendingRestartTransitions } from '../restartDrain/gate.js';

const filter: DigestFilter = { severityFloor: 'INFO', ignoreRuleIds: [], ignoreFingerprints: [] };
const raw = { results: [
  { check_id: 'security.eval', path: 'src/a.ts', start: { line: 2 }, extra: { fingerprint: 'one', severity: 'ERROR', lines: 'eval(input)', message: 'unsafe eval' } },
  { check_id: 'quality.rule', path: 'src/b.ts', start: { line: 1 }, extra: { fingerprint: 'two', severity: 'WARNING', lines: 'value', message: 'noise' } },
  { check_id: 'security.native', path: 'src/c.ts', start: { line: 1 }, extra: { fingerprint: 'native', severity: 'ERROR', is_ignored: true } },
] };
function fixture(project = path.resolve('review-fixture')): ReviewRun {
  const findings = parseOpengrepJson(raw, project).findings;
  const run: ReviewRun = { id: 'sreview_100_abcd', project, scanId: 'og_triage_test', targets: [project], harness: 'claude', status: 'done', createdAt: 100, findings,
    inputs: { configuration: 'rules', files: { 'src/a.ts': 'a', 'src/b.ts': 'b', 'src/c.ts': 'c', 'src/helper.ts': 'h' } }, recommendations: [] };
  run.recommendations = validateRecommendations({ recommendations: [
    { findingId: 'one', action: 'fix', confidence: 'high', rationale: 'User input reaches eval', evidence: 'src/a.ts:2', proposedChange: 'Use a whitelist parser', checks: ['Reject injected expressions'], contextFiles: ['src/helper.ts'], group: 'Input validation' },
    { findingId: 'two', action: 'suppress', confidence: 'medium', rationale: 'The call is a mock fixture', evidence: 'src/b.ts:1 is test data', proposedChange: 'Rule-specific comment', checks: [], contextFiles: [], group: 'Fixture' },
  ] }, run);
  return run;
}
test('native ignores and durable local dispositions stay inspectable, expire and undo', async () => withTempDir('lattice-triage-', async (project) => {
  const parsed = parseOpengrepJson(raw, project);
  assert.equal(parsed.findings[2].nativeIgnored, true);
  assert.equal(buildDigest(parsed, filter).shown, 2);
  await Promise.all(parsed.findings.slice(0, 2).map((f) => setFindingDisposition(project, f, { status: 'ignored', reason: `False positive ${f.path}` })));
  const state = await readTriage(project);
  assert.equal(Object.keys(state.entries).length, 2);
  assert.equal(state.history.length, 2, 'serialized writes preserve both changes');
  let triaged = await withFindingTriage(project, parsed, filter);
  assert.equal(buildDigest(triaged, filter).shown, 0);
  assert.equal(triaged.findings.length, 3, 'ignored items remain in the viewer inventory');
  assert.equal(triaged.findings[2].triage?.scope, 'source');
  await setFindingDisposition(project, parsed.findings[0], { status: 'open' });
  triaged = await withFindingTriage(project, parsed, filter);
  assert.equal(buildDigest(triaged, filter).shown, 1);
  assert.equal((await readTriage(project)).history.length, 3);
  assert.throws(() => validateDisposition({ status: 'deferred', reason: 'Needs a migration' }), /owner/);
  assert.throws(() => validateDisposition({ status: 'ignored', reason: '' }), /reason/);
  const entry = validateDisposition({ status: 'deferred', reason: 'Needs a migration', owner: 'Platform', reviewAt: '2099-01-01' });
  assert.equal(effectiveDisposition(entry, Date.parse('2099-01-02')).status, 'open');
  assert.equal(effectiveDisposition(entry, Date.parse('2099-01-02')).expired, true);
  await fs.writeFile(triageFile(project), '{broken');
  await assert.rejects(setFindingDisposition(project, parsed.findings[0], { status: 'open' }));
  assert.equal(await fs.readFile(triageFile(project), 'utf8'), '{broken', 'corrupt state is never silently replaced');
}));
test('legacy Settings ignores are identified without changing native CI behavior', async () => withTempDir('lattice-triage-settings-', async (project) => {
  const parsed = await withFindingTriage(project, parseOpengrepJson(raw, project), { ...filter, ignoreRuleIds: ['eval'] });
  assert.equal(parsed.findings[0].triage?.scope, 'settings');
  assert.equal(parsed.findings[0].triage?.status, 'ignored');
  assert.equal(buildDigest(parsed, { ...filter, ignoreRuleIds: ['eval'] }).shown, 1);
}));
test('review schema rejects unknown/duplicate findings and unsupported context; omissions need review', () => {
  const run = fixture();
  assert.equal(run.recommendations[2].action, 'needs-review');
  for (const patch of [{ findingId: 'invented' }, { action: 'ignore-all' }, { evidence: '' }, { contextFiles: ['../private'] }, { checks: [] }]) {
    assert.throws(() => validateRecommendations({ recommendations: [{ ...run.recommendations[0], ...patch }] }, run));
  }
  assert.throws(() => validateRecommendations({ recommendations: [run.recommendations[0], run.recommendations[0]] }, run), /duplicate/);
  assert.equal(recommendationIsStale(run.recommendations[0], run, run.inputs), false);
  assert.equal(recommendationIsStale(run.recommendations[0], run, { ...run.inputs, files: { ...run.inputs.files, 'src/helper.ts': 'changed' } }), true);
  assert.equal(recommendationIsStale(run.recommendations[0], run, { ...run.inputs, configuration: 'new-rules' }), true);
  assert.equal(recommendationIsStale(run.recommendations[0], run, null), true);
  assert.ok(!('inputs' in publicReview(run, run.inputs)), 'do not send the input inventory to the browser');
});
test('application preview groups fixes, distinguishes shared/local ignores and requires risk ownership', () => {
  const run = fixture();
  let plan = planRecommendations(run, [{ findingId: 'one' }, { findingId: 'two', scope: 'shared' }], run.inputs);
  assert.deepEqual(plan.counts, { fixes: 1, sharedIgnores: 1, localIgnores: 0, deferred: 0 });
  assert.match(plan.tasks[1].description, /nosemgrep: <exact-rule-id>/);
  assert.match(plan.tasks[1].description, /no --disable-nosem/);
  plan = planRecommendations(run, [{ findingId: 'two', scope: 'local' }], run.inputs);
  assert.equal(plan.local[0].disposition.status, 'ignored');
  assert.throws(() => planRecommendations(run, [{ findingId: 'native' }], run.inputs), /human review/);
  assert.throws(() => planRecommendations(run, [{ findingId: 'one' }], { ...run.inputs, configuration: 'changed' }), /changed/);
  run.recommendations[1].action = 'defer';
  assert.throws(() => planRecommendations(run, [{ findingId: 'two' }], run.inputs), /owner/);
  assert.equal(planRecommendations(run, [{ findingId: 'two', owner: 'Security', reviewAt: '2099-01-01' }], run.inputs).counts.deferred, 1);
});
test('selected application is durable and double clicks cannot duplicate tasks or ignores', async () => withTempDir('lattice-review-apply-', async (project) => {
  const run = fixture(project);
  await updateReviewStore(project, (s) => { s.runs.push(run); });
  const selections = [{ findingId: 'one' }, { findingId: 'two', scope: 'local' as const }];
  const deps = { inputs: async () => run.inputs };
  const preview = await applyRecommendations(project, run.id, selections, true, deps);
  assert.equal(preview.tasks.length, 1);
  assert.equal((await listTasks(project)).length, 0, 'preview must have no side effects');
  await Promise.all([applyRecommendations(project, run.id, selections, false, deps), applyRecommendations(project, run.id, selections, false, deps)]);
  assert.equal((await listTasks(project)).length, 1);
  assert.equal((await readTriage(project)).history.length, 1);
  const persisted = (await readReviewStore(project)).runs[0];
  assert.ok(persisted.recommendations[0].applied?.taskId);
  assert.equal(persisted.recommendations[1].applied?.action, 'ignored');
  assert.equal(persisted.recommendations[2].applied, undefined, 'unselected/uncertain findings are untouched');
}));
test('completion collects a validated report after restart, is idempotent and guards scratch paths', async () => withTempDir('lattice-review-done-', async (project) => {
  const run = fixture(project); run.status = 'running'; run.id = reviewPaths.createSessionId();
  const cwd = reviewPaths.assertSafeSessionPath(project, run.id);
  assert.ok(!cwd.startsWith(project));
  assert.throws(() => reviewPaths.assertSafeSessionPath(project, '../project'), /id/i);
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'recommendations.json'), JSON.stringify({ recommendations: run.recommendations.slice(0, 2) }));
  await updateReviewStore(project, (s) => { s.runs.push(run); });
  let cleanups = 0;
  await finishReview(project, run.id, { cleanup: async () => { cleanups++; } });
  await finishReview(project, run.id, { cleanup: async () => { cleanups++; } });
  const saved = (await readReviewStore(project)).runs[0];
  assert.equal(saved.status, 'done');
  assert.equal(saved.recommendations.length, 3);
  assert.ok(cleanups >= 1);
  assert.ok(saved.finishedAt);
}));
test('triage HTTP routes validate project scope and keep a complete ignored inventory', async () => withTempDir('lattice-triage-route-', async (project) => {
  const dir = projectScansDir(project); await fs.mkdir(dir, { recursive: true });
  const id = 'og_triage_test';
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(raw));
  await fs.writeFile(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, project, startedAt: 100, finishedAt: 200, durationMs: 100, exitCode: 0, engine: { version: '1.30.0', source: 'path' }, targets: [project], packIds: [], rulePaths: [] }));
  const app = express(); app.use(express.json()); app.use(buildOpengrepReviewRouter('http://localhost:1'));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(`${base}/api/opengrep/triage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ project: 'relative', findingId: 'one' })).status, 400);
    assert.equal((await post({ project, findingId: 'other', status: 'ignored', reason: 'bad' })).status, 400);
    const changed = await post({ project, scanId: id, findingId: 'one', status: 'ignored', reason: 'Validated test fixture' });
    assert.equal(changed.status, 200, await changed.text());
    const history = await fetch(`${base}/api/opengrep/triage?${new URLSearchParams({ project, findingId: 'one' })}`).then((r) => r.json()) as { history: unknown[] };
    assert.equal(history.history.length, 1);
    assert.equal((await post({ project, scanId: id, findingId: 'native', status: 'open' })).status, 400);
    assert.ok(homeProjectDir(project));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}));
test('a review waiting for spawn admission can be cancelled without leaving a terminal or overwriting cancelled state', async () => withTempDir('lattice-review-queued-', async (project) => {
  const run = fixture(project);
  let ready!: (id: string) => void;
  const materialized = new Promise<string>((resolve) => { ready = resolve; });
  let command = '', brief = '', cleanups = 0;
  const started = startReviewSession({ project, scanId: run.scanId, targets: run.targets, findings: run.findings, inputs: run.inputs, harness: 'codex', backendOrigin: 'http://localhost:5184' }, {
    cleanup: async () => { cleanups++; },
    start: async (opts) => {
      const id = opts.paths.createSessionId(); const cwd = opts.paths.assertSafeSessionPath(project, id);
      await fs.mkdir(cwd, { recursive: true });
      command = opts.buildCommand({ instructionsFile: path.join(cwd, 'SECURITY_REVIEW.md') });
      brief = await opts.renderInstructions({ id, cwd });
      ready(id);
      return new Promise((_resolve, reject) => opts.signal!.addEventListener('abort', () => reject(new Error('Cancelled admission')), { once: true }));
    },
  });
  // Observe rejection before triggering the abort so it cannot become unhandled.
  const rejected = assert.rejects(started, /Cancelled admission/);
  const id = await materialized;
  assert.match(command, /--sandbox workspace-write --ask-for-approval never/);
  assert.doesNotMatch(command, /--yolo/);
  assert.match(brief, /Never edit, delete, commit, suppress or execute project code/);
  assert.match(brief, /Pi must send this POST/);
  assert.deepEqual(await cancelSecurityReview(project, id, { cleanup: async () => { cleanups++; } }), { cancelled: true });
  await rejected;
  assert.equal((await readReviewStore(project)).runs[0].status, 'cancelled');
  assert.ok(cleanups >= 1);
  assert.ok(!pendingRestartTransitions().some((t) => t.startsWith('security-review-start')));
}));
