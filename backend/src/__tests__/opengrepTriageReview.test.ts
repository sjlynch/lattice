import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { withTempDir } from './helpers/tempDir.js';
import { parseOpengrepJson, buildDigest, type DigestFilter } from '../opengrep/digest.js';
import { effectiveDisposition, readTriage, setFindingDisposition, triageFile, validateDisposition, withFindingTriage } from '../opengrep/triage.js';
import { isActiveReview, readReviewStore, reviewStoreFile, updateReviewStore, type ReviewRun } from '../opengrep/reviewStore.js';
import { cancelSecurityReview, listSecurityReviews } from '../opengrep/review.js';
import { finishReview, reviewPaths, startReviewSession } from '../opengrep/reviewSession.js';
import { listTasks } from '../tasks.js';
import { projectScansDir } from '../opengrep/paths.js';
import { buildOpengrepReviewRouter } from '../routes/opengrepReview.js';
import { homeProjectDir } from '../projectPath.js';
import { reconcileSecurityReviews } from '../opengrep/reviewRecovery.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import type { TerminalRecord } from '../terminalRegistry/types.js';
import { pendingRestartTransitions } from '../restartDrain/gate.js';

const filter: DigestFilter = { severityFloor: 'INFO', ignoreRuleIds: [], ignoreFingerprints: [] };
const raw = { results: [
  { check_id: 'security.eval', path: 'src/a.ts', start: { line: 2 }, extra: { fingerprint: 'one', severity: 'ERROR', lines: 'eval(input)', message: 'unsafe eval' } },
  { check_id: 'quality.rule', path: 'src/b.ts', start: { line: 1 }, extra: { fingerprint: 'two', severity: 'WARNING', lines: 'value', message: 'noise' } },
  { check_id: 'security.native', path: 'src/c.ts', start: { line: 1 }, extra: { fingerprint: 'native', severity: 'ERROR', is_ignored: true } },
] };
function fixture(project = path.resolve('review-fixture')): ReviewRun {
  return { id: 'sreview_100_abcd', project, scanId: 'og_triage_test', harness: 'claude',
    status: 'running', createdAt: 100, updatedAt: 100, findingCount: 2 };
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
test('review storage keeps metadata only, protects legacy/corrupt data and never evicts waiting conversations', async () => withTempDir('lattice-review-store-', async (project) => {
  const legacy = path.join(homeProjectDir(project), 'opengrep-reviews.json');
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(legacy, '{"oldReport":"keep"}');
  assert.deepEqual((await readReviewStore(project)).runs, []);
  await updateReviewStore(project, (store) => {
    store.runs.push({ ...fixture(project), status: 'awaiting-decision', recommendations: ['must not persist'], findings: ['must not persist'], inputs: {} } as ReviewRun);
    for (let i = 0; i < 25; i++) store.runs.push({ ...fixture(project), id: `sreview_${i + 200}_ab`, createdAt: i + 200, status: 'closed' });
  });
  const state = await readReviewStore(project);
  assert.equal(state.runs.length, 21);
  assert.equal(state.runs.filter(isActiveReview).length, 1);
  const text = await fs.readFile(reviewStoreFile(project), 'utf8');
  assert.doesNotMatch(text, /recommendations|findings|inputs/);
  assert.equal(await fs.readFile(legacy, 'utf8'), '{"oldReport":"keep"}');
  assert.equal((await listSecurityReviews(project)).length, 21);
  await fs.writeFile(reviewStoreFile(project), '{broken');
  await assert.rejects(updateReviewStore(project, (store) => { store.runs.length = 0; }));
  assert.equal(await fs.readFile(reviewStoreFile(project), 'utf8'), '{broken');
}));

test('turn completion keeps the conversation and creates no report, tasks or dispositions; late callbacks cannot revive cancellation', async () => withTempDir('lattice-review-turn-', async (project) => {
  const run = fixture(project); run.id = reviewPaths.createSessionId();
  const cwd = reviewPaths.assertSafeSessionPath(project, run.id);
  assert.ok(!cwd.startsWith(project));
  assert.throws(() => reviewPaths.assertSafeSessionPath(project, '../project'), /id/i);
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'findings.json'), JSON.stringify(raw));
  await updateReviewStore(project, (store) => { store.runs.push(run); });
  await finishReview(project, run.id);
  await finishReview(project, run.id);
  let saved = (await readReviewStore(project)).runs[0];
  assert.equal(saved.status, 'awaiting-decision');
  assert.ok(saved.lastTurnAt);
  assert.equal(saved.finishedAt, undefined);
  assert.equal((await fs.stat(cwd)).isDirectory(), true, 'Stop must not reclaim cwd or kill the PTY');
  assert.equal((await listTasks(project)).length, 0);
  assert.equal((await readTriage(project)).history.length, 0);
  let cleaned = 0;
  await cancelSecurityReview(project, run.id, { cleanup: async () => { cleaned++; } });
  await finishReview(project, run.id);
  saved = (await readReviewStore(project)).runs[0];
  assert.equal(saved.status, 'cancelled');
  assert.equal(cleaned, 1);
}));

test('an early Stop before launch bookkeeping retains its terminal and interactive brief', async () => withTempDir('lattice-review-early-stop-', async (project) => {
  let cleaned = 0, brief = '';
  const started = await startReviewSession({ project, scanId: 'og_triage_test', findings: parseOpengrepJson(raw, project).findings.slice(0, 1), harness: 'claude', backendOrigin: 'http://localhost:5184' }, {
    cleanup: async () => { cleaned++; },
    start: async (opts) => {
      const id = opts.paths.createSessionId(), cwd = opts.paths.assertSafeSessionPath(project, id);
      await fs.mkdir(cwd, { recursive: true });
      assert.equal(opts.registryOwner, 'user', 'ordinary conversation restore must be allowed');
      brief = await opts.renderInstructions({ id, cwd });
      await opts.installHooks({ id, cwd });
      const pi = await fs.readFile(path.join(cwd, '.pi/extensions/lattice-complete.ts'), 'utf8');
      assert.match(pi, /pi.on\("agent_settled"/);
      assert.doesNotMatch(pi, /pi.on\("session_shutdown"/);
      await finishReview(project, id);
      return { id, cwd, command: 'claude', serverId: 'fake-pty', terminalId: 'fake-tab' };
    },
  });
  const run = (await readReviewStore(project)).runs[0];
  assert.equal(run.status, 'awaiting-decision');
  assert.equal(run.terminalId, started.terminalId);
  assert.equal(cleaned, 0);
  assert.match(brief, /Scope: EXACTLY the 1 findings/);
  assert.match(brief, /STOP AND WAIT FOR AN EXPLICIT REPLY/);
  assert.match(brief, /recommended\/default option is not authorization/);
  assert.match(brief, /ordinary Open lane/);
  assert.match(brief, /opengrep:<shortFingerprint>/);
  assert.match(brief, /Never implement on main/);
  assert.match(brief, /Do not create recommendations.json/);
}));

test('waiting reviews survive long absences, executor replacement and retryable restore failures; closed tabs are reclaimed', async () => withTempDir('lattice-review-recovery-', async (project) => {
  const run = { ...fixture(project), status: 'awaiting-decision' as const, terminalId: 'fake-tab' };
  await updateReviewStore(project, (store) => { store.runs.push(run); });
  let now = 10 * 60 * 60_000, cleanups = 0;
  let terminal: TerminalRecord | null = { id: 'fake-tab', projectPath: project, cwd: reviewPaths.assertSafeSessionPath(project, run.id),
    label: 'Security review', owner: 'user', launch: {}, order: 0, createdAt: 100, updatedAt: 100 };
  const deps = { now: () => now, registry: { get: async () => terminal }, cleanup: async () => { cleanups++; }, pending: () => false };
  await reconcileSecurityReviews(project, new Set(), deps);
  now += 3 * 60 * 60_000;
  terminal.ended = { at: now, reason: 'restore-failed' };
  await reconcileSecurityReviews(project, new Set(), deps);
  assert.equal((await readReviewStore(project)).runs[0].status, 'awaiting-decision');
  assert.equal(cleanups, 0);
  terminal = null;
  await reconcileSecurityReviews(project, null, deps);
  await reconcileSecurityReviews(project, new Set(), deps);
  now += 91_000;
  await reconcileSecurityReviews(project, new Set(), deps);
  assert.equal((await readReviewStore(project)).runs[0].status, 'closed');
  assert.equal(cleanups, 1);
}));

test('review status uses current terminal identity and busy turns without exposing conversation content', async () => withTempDir('lattice-review-status-', async (project) => {
  const run = { ...fixture(project), status: 'awaiting-decision' as const, lastTurnAt: 200 };
  const tab = await terminalRegistry.create({ projectPath: project, cwd: reviewPaths.assertSafeSessionPath(project, run.id),
    label: 'Security review', owner: 'user', launch: {}, serverId: 'restored-pty', lastBusy: { busy: true, at: 300 } });
  run.terminalId = tab.id;
  await updateReviewStore(project, (store) => { store.runs.push(run); });
  const publicRun = (await listSecurityReviews(project))[0];
  assert.equal(publicRun.status, 'running');
  assert.equal(publicRun.serverId, 'restored-pty');
  assert.equal('recommendations' in publicRun, false);
  await terminalRegistry.update(tab.id, { lastBusy: { busy: false, at: 400 } }, project);
  assert.equal((await listSecurityReviews(project))[0].status, 'awaiting-decision');
  await terminalRegistry.remove(tab.id, project);
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
  const started = startReviewSession({ project, scanId: run.scanId, findings: parseOpengrepJson(raw, project).findings, harness: 'codex', backendOrigin: 'http://localhost:5184' }, {
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
  assert.match(brief, /STOP AND WAIT FOR AN EXPLICIT REPLY/);
  assert.match(command, /sandbox_workspace_write.network_access=true/);
  assert.deepEqual(await cancelSecurityReview(project, id, { cleanup: async () => { cleanups++; } }), { cancelled: true });
  await rejected;
  assert.equal((await readReviewStore(project)).runs[0].status, 'cancelled');
  assert.ok(cleanups >= 1);
  assert.ok(!pendingRestartTransitions().some((t) => t.startsWith('security-review-start')));
}));
