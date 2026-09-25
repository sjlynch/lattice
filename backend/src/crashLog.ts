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
//     access violation. See crashLog/liveMirror.ts.
//
// Everything here is best-effort: logging must never itself take the process
// down, so every filesystem call is wrapped.
//
// The pieces live in crashLog/: liveMirror.ts (the live file and its adoption
// on the next boot), retention.ts (what we own and how much we keep), format.ts
// (text helpers). This module owns the ring, the console tee, the crash-file
// writer and the installer.

import { Console } from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSinkStream } from './consoleSink.js';
import {
  CRASH_SEQ_WIDTH,
  describe,
  fileTimestamp,
  formatArg,
  memSummary,
} from './crashLog/format.js';
import {
  adoptOrphanedLiveLogs,
  markLiveDirty,
  removeLiveFile,
  startLiveSnapshots,
} from './crashLog/liveMirror.js';
import { pruneOldFiles } from './crashLog/retention.js';

export { adoptOrphanedLiveLogs };

const RING_CAPACITY = 300;
const MAX_LINE_CHARS = 2000;

// A process killed by signal N conventionally exits with 128 + N — what Node's
// own default handler would have produced.
const POSIX_SIGNAL_EXIT_BASE = 128;

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
  markLiveDirty();
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

// Write one crash file synchronously. Returns its path, or null if it couldn't
// be written (in which case the caller's existing stderr output is all there is).
export function writeCrashLog(kind: string, errOrReason: unknown): string | null {
  const dir = ensureDir();
  if (!dir) return null;
  const stamp = fileTimestamp();
  // The counter keeps two crashes in the same millisecond from landing on the
  // same filename and silently overwriting each other — which is exactly what a
  // crash loop does. Zero-padded so the name still sorts chronologically.
  const seq = String(crashSeq++).padStart(CRASH_SEQ_WIDTH, '0');
  const file = path.join(dir, `crash-${stamp}-${seq}-${processLabel}.log`);
  const mem = process.memoryUsage();
  const body = [
    `lattice ${processLabel} crash`,
    `when:      ${new Date().toISOString()}`,
    `kind:      ${kind}`,
    `pid:       ${process.pid}`,
    `node:      ${process.version} (${process.platform} ${process.arch})`,
    `uptime:    ${Math.round(process.uptime())}s`,
    `memory:    ${memSummary(mem, { heapTotal: true })}`,
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
  process.exit(POSIX_SIGNAL_EXIT_BASE + (os.constants.signals[signal] ?? 0));
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
    startLiveSnapshots(dir, label, () => ring);
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
