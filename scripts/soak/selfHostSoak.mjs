#!/usr/bin/env node
// Self-hosting soak: does a Lattice workflow survive its backend being killed
// over and over mid-flight — the way it is when Lattice merges changes into
// its own repo and every merge restarts the backend?
//
//   node scripts/soak/selfHostSoak.mjs [--tasks 8] [--chaos 10-30] [--down 0-4]
//                                      [--timeout 25] [--no-chaos] [--keep]
//
// What it does, all in a throwaway temp dir (nothing touches your ~/.lattice,
// your live backend :5184 or your terminal-server :5185):
//   - an isolated Lattice backend from the checkout's `backend/dist` (so keep
//     `npm run dev` running, or build first) on PORT 5484 / TERMINAL_PORT 5485
//     with HOME redirected;
//   - a throwaway git project; half the tasks append to the SAME file, so every
//     merge after the first conflicts and runs the resolver flow;
//   - a fake `claude` (./fakeClaude.mjs) first on PATH that does the work a
//     real agent would and then runs the exact Stop hook Lattice installed;
//   - a workflow Start → Merge → Run tests → Push, with the post-merge hook on;
//   - chaos: the backend is hard-killed (TerminateProcess / SIGKILL — no
//     graceful anything) every --chaos seconds and restarted after --down
//     seconds, until the workflow finishes.
// Then it checks the invariants that "no friction" means and prints a report.
// Exit 0 = every invariant held.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function range(spec) {
  const [a, b] = String(spec).split('-').map(Number);
  return [a, Number.isFinite(b) ? b : a];
}

const TASKS = Number(arg('tasks', 8));
const [CHAOS_MIN, CHAOS_MAX] = range(arg('chaos', '10-30'));
const [DOWN_MIN, DOWN_MAX] = range(arg('down', '0-4'));
const TIMEOUT_MIN = Number(arg('timeout', 25));
const CHAOS = !arg('no-chaos', false);
const KEEP = !!arg('keep', false);
const PORT = Number(arg('port', 5484));
const TERMINAL_PORT = Number(arg('terminal-port', 5485));
const ORIGIN = `http://127.0.0.1:${PORT}`;

const distEntry = path.join(repoRoot, 'backend', 'dist', 'index.js');
if (!fs.existsSync(distEntry)) {
  console.error('backend/dist/index.js is missing — build the backend (or keep `npm run dev` running) first.');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-soak-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
const bin = path.join(root, 'bin');
const soakLog = path.join(root, 'fake-agents.jsonl');
for (const d of [home, project, bin, path.join(root, 'tmp')]) fs.mkdirSync(d, { recursive: true });

const say = (...a) => console.log(`[soak ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ── the throwaway project ────────────────────────────────────────────────
function g(args, cwd = project) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
g(['init', '-q', '-b', 'main']);
// Repo-local identity: the isolated HOME has no ~/.gitconfig, and both the
// fake agents' commits and Lattice's in-worktree merges need one.
g(['config', 'user.name', 'Lattice Soak']);
g(['config', 'user.email', 'soak@example.invalid']);
fs.writeFileSync(path.join(project, 'README.md'), '# soak project\n');
fs.writeFileSync(path.join(project, 'shared.txt'), 'shared log\n');
g(['add', '-A']);
g(['commit', '-q', '-m', 'initial']);

// ── the fake harness, first on PATH ─────────────────────────────────────
const fake = path.join(here, 'fakeClaude.mjs');
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
} else {
  const sh = path.join(bin, 'claude');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
}

const env = { ...process.env };
// A backend started from inside a Claude Code session scrubs these itself;
// the fake agent doesn't care, but keep the child env honest.
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  PORT: String(PORT),
  TERMINAL_PORT: String(TERMINAL_PORT),
  LATTICE_DEFAULT_ROOT: project,
  // The backend prunes projects.json entries under os.tmpdir() as test junk at
  // every boot, which would make this very project invisible to restart
  // recovery. Give the instance a temp dir the project isn't under.
  TEMP: path.join(root, 'tmp'),
  TMP: path.join(root, 'tmp'),
  TMPDIR: path.join(root, 'tmp'),
  [pathKey]: `${bin}${path.delimiter}${env[pathKey] ?? ''}`,
  // The pty PATH puts the Windows registry PATH ahead of anything inherited,
  // so the fake needs this to stay ahead of a real `claude` in every terminal.
  LATTICE_PTY_PATH_PREPEND: bin,
  SOAK_LOG: soakLog,
  SOAK_FAKE_DELAY: '1500-8000',
});

// ── backend lifecycle (what the dev runner does, minus the manners) ──────
let backend = null;
let backendGen = 0;
let restarts = 0;

function startBackend() {
  const gen = ++backendGen;
  const out = fs.openSync(path.join(root, `backend-${gen}.log`), 'a');
  backend = spawn(process.execPath, [distEntry], {
    cwd: path.join(repoRoot, 'backend'),
    env,
    stdio: ['ignore', out, out],
  });
  backend.gen = gen;
  return backend;
}

async function killBackend() {
  const b = backend;
  if (!b || b.exitCode !== null) return;
  const exited = new Promise((r) => b.once('exit', r));
  b.kill('SIGKILL');
  await exited;
}

async function api(method, p, body, { retryMs = 60_000 } = {}) {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      const res = await fetch(`${ORIGIN}${p}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 503 || res.status === 502) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json };
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(500);
    }
  }
}

async function waitHealthy() {
  await api('GET', '/api/health', undefined, { retryMs: 120_000 });
}

const P = encodeURIComponent(project);

// ── setup ────────────────────────────────────────────────────────────────
say(`root ${root}`);
startBackend();
await waitHealthy();
say(`isolated backend up on ${ORIGIN}`);

await api('PATCH', `/api/settings?project=${P}`, {
  postMergeHookEnabled: true,
  postMergeHookHarness: 'claude',
  postMergeHookPrompt: 'Soak post-merge check: nothing to do.',
});

const taskIds = [];
const expectedLines = [];
for (let i = 1; i <= TASKS; i++) {
  const conflicting = i % 2 === 0;
  const file = conflicting ? 'shared.txt' : `own/task-${i}.txt`;
  const line = `soak line ${i} (${conflicting ? 'shared' : 'own'})`;
  expectedLines.push({ file, line });
  const r = await api('POST', '/api/tasks', {
    project,
    title: `soak task ${i}`,
    description: `Append one line to a file and commit.\n\nSOAK-EDIT: ${file} :: ${line}\n`,
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`task create failed: ${r.status} ${JSON.stringify(r.json)}`);
  taskIds.push(r.json.id);
}
say(`created ${taskIds.length} tasks (${Math.floor(TASKS / 2)} conflict on shared.txt)`);

const step = (kind, title) => ({ id: `s_${kind}`, title, prompt: '', harness: 'claude', kind });
const wf = await api('POST', '/api/workflows', {
  project,
  name: 'soak',
  steps: [step('start', 'Start'), step('merge', 'Merge'), step('test', 'Run tests'), step('push', 'Push')],
});
if (wf.status !== 200 && wf.status !== 201) throw new Error(`workflow create failed: ${wf.status} ${JSON.stringify(wf.json)}`);
const started = await api('POST', `/api/workflows/${wf.json.id}/run`, {});
if (started.status !== 200) throw new Error(`workflow start failed: ${started.status} ${JSON.stringify(started.json)}`);
const runId = started.json.run.id;
say(`workflow run ${runId} started`);

// ── chaos until the run finishes ───────────────────────────────────────
const t0 = Date.now();
let finalRun = null;
let nextKill = Date.now() + rand(CHAOS_MIN, CHAOS_MAX) * 1000;
while (Date.now() - t0 < TIMEOUT_MIN * 60_000) {
  const r = await api('GET', `/api/workflow-runs/${runId}?project=${P}`, undefined, { retryMs: 120_000 }).catch(() => null);
  const run = r?.json?.run ?? r?.json;
  if (run && run.status && run.status !== 'running') {
    finalRun = run;
    break;
  }
  if (CHAOS && Date.now() >= nextKill) {
    await killBackend();
    restarts++;
    const down = rand(DOWN_MIN, DOWN_MAX) * 1000;
    say(`chaos: killed backend (restart #${restarts}) at step ${run?.currentStepIndex ?? '?'}; down ${Math.round(down / 100) / 10}s`);
    await sleep(down);
    startBackend();
    await waitHealthy();
    nextKill = Date.now() + rand(CHAOS_MIN, CHAOS_MAX) * 1000;
  }
  await sleep(1000);
}
const elapsed = Math.round((Date.now() - t0) / 1000);

// Let the tail settle (outbox drain, post-merge hook, cleanup) without chaos.
// An entry a hook left while the backend was down is held until the hook's own
// retry budget runs out (~70 s), then replayed on the drain's 10 s cadence.
const outboxDirForSettle = path.join(home, '.lattice', 'callback-outbox');
const outboxEntries = () =>
  fs.existsSync(outboxDirForSettle) ? fs.readdirSync(outboxDirForSettle).filter((n) => n.endsWith('.json')) : [];
await sleep(15_000);
for (let waited = 15_000; outboxEntries().length > 0 && waited < 120_000; waited += 2000) await sleep(2000);

// ── invariants ─────────────────────────────────────────────────────────
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

check(finalRun?.status === 'completed', `workflow run ended ${finalRun?.status ?? 'NOT AT ALL (timeout)'}${finalRun?.error ? `: ${finalRun.error}` : ''}`);

const list = await api('GET', `/api/tasks?project=${P}&status=all&fields=full&clip=0&limit=0&confirm_large=1`);
const tasks = (list.json?.tasks ?? []).filter((t) => taskIds.includes(t.id));
const byStatus = {};
for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
for (const t of tasks) {
  check(t.status === 'qa' || t.status === 'done', `task ${t.title} ended ${t.status}${t.conflict ? ' (conflict)' : ''}`);
}

const mainLog = g(['log', '--oneline', 'main']);
for (const { file, line } of expectedLines) {
  const p = path.join(project, file);
  const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  // CRLF: Git for Windows' system config checks out with core.autocrlf.
  check(content.split(/\r?\n/).includes(line), `main is missing "${line}" in ${file}`);
}
check(!/<<<<<<<|>>>>>>>/.test(fs.readFileSync(path.join(project, 'shared.txt'), 'utf8')), 'conflict markers on main');

const worktrees = g(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
check(worktrees === 1, `${worktrees - 1} task worktree(s) still registered`);

const outboxDir = path.join(home, '.lattice', 'callback-outbox');
const pending = fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).filter((n) => n.endsWith('.json')) : [];
check(pending.length === 0, `${pending.length} undelivered callback(s) left in the outbox`);

const events = fs.existsSync(soakLog)
  ? fs.readFileSync(soakLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const starts = events.filter((e) => e.event === 'start');
const sessionsBy = {};
for (const e of starts) sessionsBy[e.kind] = (sessionsBy[e.kind] ?? 0) + 1;
const pushSessions = starts.filter((e) => e.kind === 'session' && /[\\/]push[\\/]/.test(e.cwd)).length;
check(pushSessions === 1, `${pushSessions} push session(s) spawned (want exactly 1)`);
const hookSessions = starts.filter((e) => e.kind === 'session' && /[\\/]post-merge-hooks[\\/]/.test(e.cwd)).length;
// The hook is on and merges landed: it must have run — even when a kill fell
// between the last merge and the hook firing (postMergeHooks/owed.ts).
check(hookSessions >= 1, 'the post-merge hook never ran');
const failedWork = events.filter((e) => e.event === 'work-failed' || e.event === 'crashed');
check(failedWork.length === 0, `${failedWork.length} fake-agent failure(s): ${failedWork.map((e) => e.error).join(' | ').slice(0, 400)}`);

const report = {
  ok: failures.length === 0,
  failures,
  elapsedSec: elapsed,
  restarts,
  run: finalRun ? { status: finalRun.status, error: finalRun.error, stepSummaries: finalRun.stepSummaries } : null,
  tasksByStatus: byStatus,
  mainCommits: mainLog.split('\n').length,
  sessionsByKind: sessionsBy,
  pushSessions,
  hookSessions,
  stopHooks: events.filter((e) => e.event === 'stop-hook').length,
  root,
};
console.log(JSON.stringify(report, null, 2));

// ── teardown ───────────────────────────────────────────────────────────
await killBackend();
try {
  const token = fs.readFileSync(path.join(home, '.lattice', 'terminalServerToken'), 'utf8').trim();
  await fetch(`http://127.0.0.1:${TERMINAL_PORT}/shutdown`, {
    method: 'POST',
    headers: { 'x-lattice-terminal-token': token },
    signal: AbortSignal.timeout(5000),
  });
} catch {
  // already gone
}
if (!KEEP && failures.length === 0) {
  await sleep(2000); // let the executor's ptys release their cwd handles
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} else {
  say(`kept ${root} for inspection (backend-*.log, fake-agents.jsonl, home/.lattice)`);
}
process.exit(failures.length === 0 ? 0 : 1);
