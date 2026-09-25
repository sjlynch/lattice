#!/usr/bin/env node
// A stand-in `claude` for the self-hosting soak (see ./selfHostSoak.mjs).
//
// The soak exercises Lattice's restart resilience — completion callbacks,
// workflow/merge-run resume, session re-adoption — so what matters is the
// PLUMBING a real agent drives, not the model: edit + commit in a task
// worktree, resolve a merge conflict, write a Run tests summary, and then run
// the exact Stop hook Lattice installed in `<cwd>/.claude/settings.local.json`.
// After that it idles like an interactive Claude at its prompt until Lattice
// kills the pty. No tokens, deterministic, fast enough to run dozens of tasks
// under repeated backend kills.
//
// It is launched by the pty's shell as `claude <whatever flags Lattice adds>`;
// every flag is ignored.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const LOG = process.env.SOAK_LOG;
const [minDelay, maxDelay] = (process.env.SOAK_FAKE_DELAY ?? '1500-8000').split('-').map(Number);

function log(event, extra = {}) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), pid: process.pid, cwd, event, ...extra })}\n`);
  } catch {
    // diagnostics only
  }
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function exists(name) {
  return fs.existsSync(path.join(cwd, name));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Union-resolve every conflicted file: keep both sides, ours first. The soak's
// conflicting tasks all append a distinct line to the same file, so the union
// is the correct resolution.
function resolveConflicts() {
  const files = (tryGit(['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
  for (const rel of files) {
    const file = path.join(cwd, rel);
    const out = [];
    let side = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.startsWith('<<<<<<< ')) side = 'ours';
      else if (line.startsWith('=======') && side === 'ours') side = 'theirs';
      else if (line.startsWith('>>>>>>> ') && side === 'theirs') side = null;
      else out.push(line);
    }
    fs.writeFileSync(file, out.join('\n'));
    git(['add', '--', rel]);
  }
  git(['commit', '--no-edit']);
  return files;
}

// `SOAK-EDIT: <relpath> :: <line>` in the task brief.
function applyTaskEdit() {
  const brief = fs.readFileSync(path.join(cwd, 'LATTICE_TASK.md'), 'utf8');
  const m = brief.match(/SOAK-EDIT: (\S+) :: (.+)/);
  if (!m) return { skipped: 'no SOAK-EDIT directive' };
  const [, rel, line] = m;
  const file = path.join(cwd, rel);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Idempotent: a relaunched/resumed session must not append twice.
  if (current.split(/\r?\n/).includes(line.trim())) return { already: rel };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line.trim()}\n`);
  git(['add', '--', rel]);
  git(['commit', '-m', `soak: ${line.trim()}`]);
  return { edited: rel };
}

function stopHookCommand() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    return cfg?.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? null;
  } catch {
    return null;
  }
}

function runStopHook() {
  const command = stopHookCommand();
  if (!command) {
    log('no-stop-hook');
    return Promise.resolve(null);
  }
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore' });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      log('stop-hook', { code, ms: Date.now() - started });
      resolve(code);
    });
  });
}

async function main() {
  const kind = tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    ? 'resolver'
    : exists('LATTICE_TASK.md')
      ? 'task'
      : exists('RUN_TESTS.md')
        ? 'run-tests'
        : exists('WORKFLOW_STEP.md')
          ? 'workflow-step'
          : 'session';
  log('start', { kind, argv: process.argv.slice(2).filter((a) => !a.startsWith('-')).length });
  await sleep(minDelay + Math.random() * Math.max(0, maxDelay - minDelay));
  try {
    if (kind === 'resolver') log('resolved', { files: resolveConflicts() });
    else if (kind === 'task') log('task-edit', applyTaskEdit());
    else if (kind === 'run-tests') {
      fs.writeFileSync(path.join(cwd, 'TEST_SUMMARY.md'), '# Soak\n\nNo tests in the soak project.\n');
      log('test-summary');
    }
  } catch (err) {
    log('work-failed', { error: String(err?.stderr || err?.message || err) });
  }
  await runStopHook();
  // Idle like an interactive session until Lattice kills the pty.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  log('crashed', { error: String(err?.stack || err) });
  setInterval(() => {}, 1 << 30);
});
