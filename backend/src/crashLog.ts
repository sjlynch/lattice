// Persistent crash logging for the two long-lived Node processes (the backend
// and the detached terminal-server).
//
// Before this, a crash left NOTHING behind: the backend's only output is the
// console of the terminal the user runs `npm run dev` in, and the
// terminal-server is spawned with `stdio: 'ignore'`, so its output goes nowhere
// at all. When the backend died mid-session the evidence was gone — no stack,
// no idea whether it was an exception, an OOM, or an external kill.
//
// What this adds, deliberately kept small:
//   - a ring buffer of the last N console lines, so a crash file carries the
//     context leading up to it rather than just the final stack;
//   - `~/.lattice/logs/crash-<ts>-<n>-<label>.log` written SYNCHRONOUSLY from the
//     fatal handler (an async write would not survive the process exiting);
//   - Node's own diagnostic report on fatal errors, which captures a JS-heap
//     OOM or a V8 fatal error — neither of which ever reaches an
//     `uncaughtException` handler;
//   - a note on any non-zero exit that didn't already write a crash file, so a
//     bare `process.exit(1)` is still traceable;
//   - a periodic mirror of the ring to `live-<label>-<pid>.log`, which is the
//     ONLY record left by a death that runs no JavaScript at all. Everything
//     above writes from a handler, and an OS-level kill reaches none of them —
//     including Node's report, which is a V8 callback and so misses a native
//     access violation. See the "Live ring mirror" section below.
//
// Everything here is best-effort: logging must never itself take the process
// down, so every filesystem call is wrapped.

import { Console } from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSinkStream } from './consoleSink.js';

const RING_CAPACITY = 300;
const MAX_LINE_CHARS = 2000;
const KEEP_FILES = 20;

// Cadence and depth of the live ring mirror (see startLiveSnapshots). Every
// other record in this file is written from a JS handler, so a death that runs
// no JavaScript — a hard native fault, an OS OOM-kill, a `taskkill /F` — leaves
// nothing at all. This is the one thing that survives it, at the cost of one
// small async write every couple of seconds while the process is logging.
const LIVE_SNAPSHOT_INTERVAL_MS = 2_000;
const LIVE_SNAPSHOT_LINES = 150;

export function crashLogDir(): string {
  return path.join(os.homedir(), '.lattice', 'logs');
}

const ring: string[] = [];
let installed = false;
let crashWritten = false;
let crashSeq = 0;
let processLabel = 'backend';

// Record a line of context. Exported so non-console call sites (a signal
// handler, a lifecycle event) can drop a breadcrumb into the crash file.
export function noteCrashContext(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  ring.push(
    stamped.length > MAX_LINE_CHARS
      ? `${stamped.slice(0, MAX_LINE_CHARS)}…[truncated]`
      : stamped,
  );
  if (ring.length > RING_CAPACITY) ring.shift();
  liveDirty = true;
}

// ---------------------------------------------------------------------------
// Live ring mirror — the record for a death that runs no JavaScript
// ---------------------------------------------------------------------------
//
// Everything else here is written from a handler: `uncaughtException`,
// `unhandledRejection`, `exit`. A process killed by the OS reaches none of
// them. On 2026-08-20 the backend died with exit code 3221225477
// (0xC0000005, STATUS_ACCESS_VIOLATION) at the end of a merge run and left
// nothing whatsoever behind — no crash file, no diagnostic report, and its
// console output lived only in the user's terminal. There was no way to tell
// which subsystem had been running.
//
// `process.report.reportOnFatalError` does not close this: it is a V8 callback,
// so it fires for a JS-heap OOM or a V8 fatal error and NOT for an access
// violation, which never routes through V8 at all.
//
// So the ring is mirrored to `live-<label>-<pid>.log` on a timer. If the
// process exits through any normal path the file is deleted; if it vanishes,
// the file stays, and the next boot promotes it to a real crash file (see
// adoptOrphanedLiveLogs). Worst case the tail is a couple of seconds stale —
// which is still the difference between naming the subsystem and guessing.

let liveFile: string | null = null;
let liveDirty = false;
let liveWriting = false;

function liveHeader(): string {
  const mem = process.memoryUsage();
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
  return [
    `lattice ${processLabel} live log (pid ${process.pid})`,
    `updated:   ${new Date().toISOString()}`,
    `uptime:    ${Math.round(process.uptime())}s`,
    `memory:    rss ${mb(mem.rss)}, heapUsed ${mb(mem.heapUsed)}`,
    '',
  ].join('\n');
}

// One write in flight at a time, and only when something new was logged, so an
// idle process writes nothing at all.
function flushLiveSnapshot(): void {
  if (!liveFile || !liveDirty || liveWriting) return;
  liveWriting = true;
  liveDirty = false;
  const body = liveHeader() + ring.slice(-LIVE_SNAPSHOT_LINES).join('\n') + '\n';
  try {
    fs.writeFile(liveFile, body, 'utf8', () => {
      liveWriting = false;
    });
  } catch {
    liveWriting = false;
  }
}

function startLiveSnapshots(dir: string, label: string): void {
  liveFile = path.join(dir, `live-${label}-${process.pid}.log`);
  const timer = setInterval(flushLiveSnapshot, LIVE_SNAPSHOT_INTERVAL_MS);
  // Never hold the process open just to mirror its own log.
  timer.unref();
}

// Any exit we are alive to observe means the live file has done its job: either
// the process left cleanly, or a handler wrote a far richer crash file with the
// same ring in it. Leaving it behind would make the next boot report a crash
// that never happened.
function removeLiveFile(): void {
  if (!liveFile) return;
  try {
    fs.unlinkSync(liveFile);
  } catch {
    /* best effort */
  }
  liveFile = null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours — still alive.
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

// A live file whose process is gone means that process died without running a
// single handler. Promote it to a crash file so it prunes and reads like every
// other one, and so the tail isn't silently overwritten by the next boot.
//
// Exported for tests: `installCrashLogging` patches the global console and
// registers process handlers, so the suite exercises the pieces it composes
// rather than the installer itself.
export function adoptOrphanedLiveLogs(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^live-(.+)-(\d+)\.log$/.exec(name);
    if (!match) continue;
    const [, label, pidText] = match;
    const pid = Number(pidText);
    if (pid === process.pid || isPidAlive(pid)) continue;
    const from = path.join(dir, name);
    let tail = '';
    try {
      tail = fs.readFileSync(from, 'utf8');
    } catch {
      /* unreadable — still remove it below so it can't accumulate */
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // The dead pid fills the slot `writeCrashLog` gives its counter: adopting
    // two orphans (a backend AND its terminal-server) in the same millisecond
    // would otherwise land them on one filename and silently lose one.
    const to = path.join(dir, `crash-${stamp}-${pid}-${label}-nojs.log`);
    const body = [
      `lattice ${label} died without running any JavaScript`,
      `noticed:   ${new Date().toISOString()} (by pid ${process.pid} at startup)`,
      `dead pid:  ${pid}`,
      '',
      'No crash file or diagnostic report was written because no handler ran.',
      'That means an OS-level kill: a hard native fault (on Windows the dev',
      "runner logs the decoded code — 0xC0000005 is a bad pointer dereference),",
      'an OOM-kill, or an external taskkill. Check the dev-runner.log record for',
      'the exit code, then read the tail below for what it was doing.',
      '',
      '--- last console lines before it vanished ---',
      tail,
      '',
    ].join('\n');
    try {
      fs.writeFileSync(to, body, 'utf8');
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(from);
    } catch {
      /* best effort */
    }
  }
  // Adoption is a file-producing path like writeCrashLog, so it has to respect
  // the same retention cap — anything that force-kills the backend in a loop
  // would otherwise grow this directory without bound.
  pruneOldFiles(dir);
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

// Mirror console output into the ring buffer while still writing it through to
// the real console — the user's terminal output is unchanged.
//
// The write itself goes through consoleSink rather than `process.stdout`: a
// paused console (a text selection in the dev terminal is enough) blocks that
// write *on the event loop* and takes the whole backend down with it. See
// consoleSink.ts. Formatting is still Node's own — the sink is handed to a
// `Console` instance, so `%s`, object inspection and friends behave exactly as
// before.
function teeConsole(): void {
  const sinkConsole = new Console({
    stdout: createSinkStream(1),
    stderr: createSinkStream(2),
    colorMode: process.stdout.isTTY === true,
  });
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    console[level] = (...args: unknown[]) => {
      try {
        noteCrashContext(`[${level}] ${args.map(formatArg).join(' ')}`);
      } catch {
        /* never let logging break logging */
      }
      sinkConsole[level](...args);
    };
  }
}

function ensureDir(): string | null {
  const dir = crashLogDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// Which retention bucket a log file belongs to, or null if we don't own it.
//
// `-nojs` files get their OWN bucket rather than sharing the `crash-` one. They
// are written on a different trigger (a boot noticing a process that vanished)
// and can arrive in bursts — anything that force-kills the backend repeatedly
// produces one per kill. Sharing a bucket would let such a burst evict the
// handler-written crash files, which are the richer record and exactly what
// you'd be looking for.
function retentionBucket(name: string): string | null {
  if (name.startsWith('report.')) return 'report';
  if (!name.startsWith('crash-')) return null;
  return name.endsWith('-nojs.log') ? 'crash-nojs' : 'crash';
}

// Keep the newest KEEP_FILES of each kind so a crash loop can't fill the disk.
// Ordered by FILENAME, not mtime: every kind embeds a timestamp as its first
// field, so a lexicographic sort is chronological — and unlike mtime it can't be
// perturbed by anything that touches the files afterwards.
function pruneOldFiles(dir: string): void {
  try {
    const names = fs.readdirSync(dir);
    const buckets = new Map<string, string[]>();
    for (const name of names) {
      const bucket = retentionBucket(name);
      if (!bucket) continue;
      const list = buckets.get(bucket) ?? [];
      list.push(name);
      buckets.set(bucket, list);
    }
    for (const group of [...buckets.values()].map((g) => g.sort().reverse())) {
      for (const stale of group.slice(KEEP_FILES)) {
        try {
          fs.unlinkSync(path.join(dir, stale));
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }
}

function describe(errOrReason: unknown): string {
  if (errOrReason instanceof Error) {
    const extra = Object.entries(errOrReason)
      .filter(([k]) => !['message', 'stack'].includes(k))
      .map(([k, v]) => `  ${k}: ${formatArg(v)}`)
      .join('\n');
    return `${errOrReason.stack ?? `${errOrReason.name}: ${errOrReason.message}`}${
      extra ? `\n${extra}` : ''
    }`;
  }
  return formatArg(errOrReason);
}

// Write one crash file synchronously. Returns its path, or null if it couldn't
// be written (in which case the caller's existing stderr output is all there is).
export function writeCrashLog(kind: string, errOrReason: unknown): string | null {
  const dir = ensureDir();
  if (!dir) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The counter keeps two crashes in the same millisecond from landing on the
  // same filename and silently overwriting each other — which is exactly what a
  // crash loop does. Zero-padded so the name still sorts chronologically.
  const seq = String(crashSeq++).padStart(3, '0');
  const file = path.join(dir, `crash-${stamp}-${seq}-${processLabel}.log`);
  const mem = process.memoryUsage();
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
  const body = [
    `lattice ${processLabel} crash`,
    `when:      ${new Date().toISOString()}`,
    `kind:      ${kind}`,
    `pid:       ${process.pid}`,
    `node:      ${process.version} (${process.platform} ${process.arch})`,
    `uptime:    ${Math.round(process.uptime())}s`,
    `memory:    rss ${mb(mem.rss)}, heapUsed ${mb(mem.heapUsed)}, heapTotal ${mb(mem.heapTotal)}`,
    `cwd:       ${process.cwd()}`,
    '',
    '--- error ---',
    describe(errOrReason),
    '',
    `--- last ${ring.length} log lines ---`,
    ...ring,
    '',
  ].join('\n');
  try {
    fs.writeFileSync(file, body, 'utf8');
    crashWritten = true;
    // This file carries the same ring and far more besides, so the live mirror
    // has nothing left to add. Dropping it here (not just from the `exit`
    // handler) covers the fatal paths that force-exit without running one.
    removeLiveFile();
    pruneOldFiles(dir);
    return file;
  } catch {
    return null;
  }
}

let exitingOnSignal = false;

function handleLifecycleSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
  noteCrashContext(`[lifecycle] received ${signal}`);
  // Another listener owns shutdown for this signal (the terminal-server's
  // graceful shutdown, the health watcher's flush-then-exit) — defer to it.
  if (process.listenerCount(signal) > 1) return;
  exitingOnSignal = true;
  process.exit(128 + (os.constants.signals[signal] ?? 0));
}

// Install once, as early in the process as possible. `label` distinguishes the
// backend's crash files from the terminal-server's.
export function installCrashLogging(label: string): void {
  if (installed) return;
  installed = true;
  processLabel = label;

  const dir = ensureDir();
  teeConsole();

  // Before writing our own: promote any live file left by a process that died
  // without running a handler, so its tail becomes a crash file rather than
  // being overwritten by whoever gets its pid next.
  if (dir) {
    adoptOrphanedLiveLogs(dir);
    pruneOldFiles(dir);
    startLiveSnapshots(dir, label);
  }

  // The only mechanism that catches a JS-heap OOM or a native/V8 fatal error —
  // those abort the process without ever reaching an uncaughtException handler,
  // which is precisely the case where we'd otherwise have nothing at all.
  if (dir) {
    try {
      process.report.directory = dir;
      process.report.reportOnFatalError = true;
      // Uncaught exceptions are covered by our own (richer) crash file, so
      // don't also emit a multi-megabyte JSON report for them.
      process.report.reportOnUncaughtException = false;
      process.report.reportOnSignal = false;
    } catch {
      /* diagnostic reports unavailable in this build — the rest still works */
    }
  }

  // A signal is an orderly shutdown, not a crash — record it so a crash file
  // written by a later handler shows the process was already going down, and so
  // "it vanished" can be told apart from "it was asked to stop".
  //
  // A listener on a signal REMOVES Node's default "terminate" for it, so this
  // breadcrumb must not be the reason the process survives: with no other
  // listener (the backend before any health watcher registers its flush hook;
  // SIGHUP always) Ctrl+C was ignored and a closed terminal left a backend
  // holding :5184. When nothing else handles the signal, exit the way Node's
  // default would have (128 + signal number) — as an orderly exit, not a crash.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => handleLifecycleSignal(signal));
  }

  // Backstop for a non-zero exit that no fatal handler covered (an explicit
  // process.exit(1), a failed startup precondition).
  process.on('exit', (code) => {
    // We got here, so a handler ran and the live mirror is redundant — drop it
    // unconditionally, or the next boot would report this orderly exit as a
    // process that vanished.
    removeLiveFile();
    if (code === 0 || crashWritten || exitingOnSignal) return;
    writeCrashLog('exit', new Error(`process exited with code ${code}`));
  });

  noteCrashContext(
    `[lifecycle] ${label} started; pid=${process.pid} node=${process.version}`,
  );
}
