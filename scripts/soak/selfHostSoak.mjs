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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoakFixture } from './soakFixture.mjs';
import { createSoakRuntime, sleep } from './soakRuntime.mjs';
import { collectSoakReport } from './soakReport.mjs';

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

const fixture = createSoakFixture({ here, port: PORT, terminalPort: TERMINAL_PORT });
const { root, home, project, env } = fixture;

const say = (...a) => console.log(`[soak ${new Date().toISOString().slice(11, 19)}]`, ...a);
const rand = (a, b) => a + Math.random() * (b - a);

// ── backend lifecycle (what the dev runner does, minus the manners) ──────
const { startBackend, killBackend, api, waitHealthy, shutdownTerminalServer } = createSoakRuntime({
  root, home, repoRoot, distEntry, env, origin: ORIGIN, terminalPort: TERMINAL_PORT,
});
let restarts = 0;

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
const report = await collectSoakReport({ fixture, api, finalRun, taskIds, expectedLines, elapsed, restarts });
const { failures } = report;
console.log(JSON.stringify(report, null, 2));

// ── teardown ───────────────────────────────────────────────────────────
await killBackend();
await shutdownTerminalServer();
if (!KEEP && failures.length === 0) {
  await sleep(2000); // let the executor's ptys release their cwd handles
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} else {
  say(`kept ${root} for inspection (backend-*.log, fake-agents.jsonl, home/.lattice)`);
}
process.exit(failures.length === 0 ? 0 : 1);
