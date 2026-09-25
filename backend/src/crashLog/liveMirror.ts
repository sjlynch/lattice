// The live ring mirror: `live-<label>-<pid>.log`, refreshed on a timer, and the
// next boot's promotion of an orphaned one to a `-nojs` crash file. The only
// record a death that runs no JavaScript leaves behind.
//
// Everything else in crashLog is written from a handler: `uncaughtException`,
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

import fs from 'node:fs';
import path from 'node:path';

import { fileTimestamp, memSummary } from './format.js';
import { pruneOldFiles } from './retention.js';

// Cadence and depth of the live ring mirror (see startLiveSnapshots). Every
// other record in crashLog is written from a JS handler, so a death that runs
// no JavaScript — a hard native fault, an OS OOM-kill, a `taskkill /F` — leaves
// nothing at all. This is the one thing that survives it, at the cost of one
// small async write every couple of seconds while the process is logging.
const LIVE_SNAPSHOT_INTERVAL_MS = 2_000;
const LIVE_SNAPSHOT_LINES = 150;

let liveFile: string | null = null;
let liveLabel = '';
let readRing: () => readonly string[] = () => [];
let liveDirty = false;
let liveWriting = false;

// Something new reached the ring; the next tick has something to write.
export function markLiveDirty(): void {
  liveDirty = true;
}

function liveHeader(): string {
  return [
    `lattice ${liveLabel} live log (pid ${process.pid})`,
    `updated:   ${new Date().toISOString()}`,
    `uptime:    ${Math.round(process.uptime())}s`,
    `memory:    ${memSummary(process.memoryUsage())}`,
    '',
  ].join('\n');
}

// One write in flight at a time, and only when something new was logged, so an
// idle process writes nothing at all.
function flushLiveSnapshot(): void {
  if (!liveFile || !liveDirty || liveWriting) return;
  liveWriting = true;
  liveDirty = false;
  const body = liveHeader() + readRing().slice(-LIVE_SNAPSHOT_LINES).join('\n') + '\n';
  try {
    fs.writeFile(liveFile, body, 'utf8', () => {
      liveWriting = false;
    });
  } catch {
    liveWriting = false;
  }
}

export function startLiveSnapshots(
  dir: string,
  label: string,
  ring: () => readonly string[],
): void {
  liveLabel = label;
  readRing = ring;
  liveFile = path.join(dir, `live-${label}-${process.pid}.log`);
  const timer = setInterval(flushLiveSnapshot, LIVE_SNAPSHOT_INTERVAL_MS);
  // Never hold the process open just to mirror its own log.
  timer.unref();
}

// Any exit we are alive to observe means the live file has done its job: either
// the process left cleanly, or a handler wrote a far richer crash file with the
// same ring in it. Leaving it behind would make the next boot report a crash
// that never happened.
export function removeLiveFile(): void {
  if (!liveFile) return;
  try {
    fs.unlinkSync(liveFile);
  } catch {
    /* best effort */
  }
  liveFile = null;
}

// Deliberately a local copy rather than `isProcessAlive` from
// projectRunLock/liveness.ts: that one differs at the edges (`isFinite` vs
// `isInteger`, `err.code` vs `err?.code`) and its module loads child_process
// and crypto — more than this very-early-boot, fatal-path code should pull in.
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
    const stamp = fileTimestamp();
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
