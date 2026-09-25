import { StringDecoder } from 'node:string_decoder';

// The console-driven control surface of `npm run dev`: the commands the user
// types into the dev console, and the one-line protocol the orchestrator
// speaks to the backend dev runner (`backend/scripts/dev.mjs`) over that
// runner's stdin.
//
// Why a soft restart exists at all: the only way to pick up a change to the
// dev scripts themselves, a dependency, or a stale terminal-server used to be
// Ctrl+C, and a real stop POSTs the terminal-server `/shutdown` — every agent
// PTY dies with it (terminal restore relaunches the conversations later, but
// the agents are interrupted mid-turn). A soft restart stops everything EXCEPT
// the detached terminal-server; the next backend re-adopts its live sessions
// exactly as it does after an ordinary `tsc -w` restart.
//
// Commands are LINES (type `r`, press Enter), not raw keypresses, on purpose.
// Raw mode clears the console's ENABLE_PROCESSED_INPUT on Windows, and that
// mode belongs to the console, not to this process: Ctrl+C would then arrive
// here as a `\x03` byte instead of reaching `backend/scripts/dev.mjs` and
// `dist/index.js` as the console break their full-stop path depends on.

// Env var the orchestrator sets on the backend child to say "your stdin is my
// control pipe". The dev runner deletes it on read so it never reaches
// `dist/index.js` — which hands its env wholesale to every agent pty.
export const DEV_CONTROL_ENV = 'LATTICE_DEV_CONTROL';
export const DEV_CONTROL_STDIN = 'stdin';

// Orchestrator → dev runner lines.
// Stop the backend + compiler + watchers and exit, WITHOUT the terminal-server
// `/shutdown` a real stop sends.
export const SOFT_STOP = 'soft-stop';
// Re-check the backend's dependencies now, even ones a failed install already
// gave up on (the `i` console command).
export const DEPS_RECHECK = 'deps-recheck';

// `scripts/devLoop.mjs` re-runs preflight + the orchestrator when the
// orchestrator exits with this code (EX_TEMPFAIL — "try again").
export const RESTART_EXIT_CODE = 75;

// How long the orchestrator waits for the dev runner to finish a soft stop
// before force-killing its tree. The runner answers at once: its only slow
// step is waiting for `dist/index.js` to exit after a TerminateProcess.
export const SOFT_STOP_TIMEOUT_MS = 20_000;

export const CONSOLE_HINT =
  'type r + Enter to restart the dev stack keeping agent terminals running · ' +
  'd = exit keeping agents running · i = re-check deps · h = help · Ctrl+C = full stop (ends agents)';

export const CONSOLE_HELP = [
  'dev console commands (type the letter, then Enter):',
  '  r   soft restart: stop the backend + vite, re-run preflight, and start everything again from the',
  '      current scripts/deps. The terminal-server stays up, so running agents are re-adopted, not killed.',
  '  d   detach: stop the backend + vite and exit, leaving the terminal-server and its agents running.',
  '      The next `npm run dev` re-adopts them.',
  '  i   re-check root/backend/frontend dependencies now and npm install any that are out of step,',
  '      including ones whose install already failed.',
  '  r! / d!   the same, even while a merge run or workflow holds a run.lock.',
  '  Ctrl+C    full stop: also shuts the terminal-server down, ending every agent terminal.',
  'Agents whose turn ends while the backend is down cannot reach it to report completion until it is back.',
];

/**
 * Pure: one console line → the command it names.
 * @returns {{ kind: 'none' | 'restart' | 'detach' | 'deps' | 'help' | 'unknown', force?: boolean, text?: string }}
 */
export function parseConsoleCommand(line) {
  const text = String(line ?? '').trim().toLowerCase();
  if (!text) return { kind: 'none' };
  const force = text.endsWith('!');
  const word = force ? text.slice(0, -1).trim() : text;
  if (word === 'r' || word === 'restart') return { kind: 'restart', force };
  if (word === 'd' || word === 'detach') return { kind: 'detach', force };
  if (!force && (word === 'i' || word === 'deps' || word === 'install')) return { kind: 'deps' };
  if (!force && (word === 'h' || word === '?' || word === 'help')) return { kind: 'help' };
  return { kind: 'unknown', text };
}

/**
 * Pure: `scripts/devLoop.mjs`'s decision after the orchestrator exits.
 * Only the dedicated code relaunches; a signal death (`code === null`) exits 1.
 */
export function relaunchAfterOrchestrator(code) {
  return code === RESTART_EXIT_CODE ? 'relaunch' : 'exit';
}

/**
 * Pure: after preflight. The first boot keeps the old strict rule (a failed
 * repair stops `npm run dev`). On a soft restart the previous stack was already
 * running on the current node_modules and agents are waiting to be re-adopted,
 * so a failed repair (e.g. EBUSY on a native module the surviving
 * terminal-server holds) must not leave the user with no backend at all.
 */
export function afterPreflight(code, { softRestart }) {
  if (code === 0) return 'continue';
  return softRestart ? 'continue-degraded' : 'exit';
}

/**
 * The orchestrator forwards a child's exit code as its own. Never let a child
 * that happened to exit 75 be mistaken for a soft-restart request.
 */
export function forwardedExitCode(code) {
  const c = code ?? 0;
  return c === RESTART_EXIT_CODE ? 1 : c;
}

/** Split a readable stream into trimmed-of-CR lines. */
export function readLines(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const flush = (text) => {
    pending += text;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      onLine(line);
    }
    // A console line is short; never let a newline-free stream grow unbounded.
    if (pending.length > 4096) pending = pending.slice(-4096);
  };
  stream.on('data', (chunk) => flush(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  stream.on('end', () => {
    flush(decoder.end());
    if (pending) onLine(pending.replace(/\r$/, ''));
    pending = '';
  });
  stream.on('error', () => {
    /* a closed control pipe is not the runner's problem */
  });
}

/**
 * Resolves true once `child` has exited (or already had), false after
 * `timeoutMs`. Structural: a ChildProcess or a fake with the same surface.
 */
export function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || (child.signalCode ?? null) !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
