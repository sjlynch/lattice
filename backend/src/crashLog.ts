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
//   - Node's own diagnostic report on fatal errors, which is the only thing
//     that captures a JS-heap OOM or a native crash — neither of those ever
//     reaches an `uncaughtException` handler;
//   - a note on any non-zero exit that didn't already write a crash file, so a
//     bare `process.exit(1)` is still traceable.
//
// Everything here is best-effort: logging must never itself take the process
// down, so every filesystem call is wrapped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RING_CAPACITY = 300;
const MAX_LINE_CHARS = 2000;
const KEEP_FILES = 20;

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
function teeConsole(): void {
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        noteCrashContext(`[${level}] ${args.map(formatArg).join(' ')}`);
      } catch {
        /* never let logging break logging */
      }
      original(...args);
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

// Keep the newest KEEP_FILES of each kind so a crash loop can't fill the disk.
// Ordered by FILENAME, not mtime: both kinds embed a timestamp as their first
// field, so a lexicographic sort is chronological — and unlike mtime it can't be
// perturbed by anything that touches the files afterwards.
function pruneOldFiles(dir: string): void {
  try {
    const names = fs.readdirSync(dir);
    for (const prefix of ['crash-', 'report.']) {
      const group = names
        .filter((f) => f.startsWith(prefix))
        .sort()
        .reverse();
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
    pruneOldFiles(dir);
    return file;
  } catch {
    return null;
  }
}

// Install once, as early in the process as possible. `label` distinguishes the
// backend's crash files from the terminal-server's.
export function installCrashLogging(label: string): void {
  if (installed) return;
  installed = true;
  processLabel = label;

  const dir = ensureDir();
  teeConsole();

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
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => noteCrashContext(`[lifecycle] received ${signal}`));
  }

  // Backstop for a non-zero exit that no fatal handler covered (an explicit
  // process.exit(1), a failed startup precondition).
  process.on('exit', (code) => {
    if (code === 0 || crashWritten) return;
    writeCrashLog('exit', new Error(`process exited with code ${code}`));
  });

  noteCrashContext(
    `[lifecycle] ${label} started; pid=${process.pid} node=${process.version}`,
  );
}
