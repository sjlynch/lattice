// Pre-boot refusals — checks that run in `index.ts` BEFORE anything touches
// ~/.lattice (crash-log adoption, Pi setup, the terminal-server handshake,
// startup recovery). Both exist because Lattice develops itself: an agent in a
// task worktree that runs `npm run dev` / `node dist/index.js` used to get all
// the way through pre-listen recovery — task-DB restore, snapshot recovery,
// branch repair, and an idle-upgrade request to the LIVE terminal-server —
// before its `listen()` finally failed with EADDRINUSE. By then it had already
// mutated the user's live instance's state.
//
// Deliberately imports nothing but node builtins: a module that computes a
// ~/.lattice path (or anything else) at load time must not run first.

import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Opt-out for the task-worktree refusal (e.g. an isolated e2e instance). */
export const ALLOW_WORKTREE_BACKEND_ENV = 'LATTICE_ALLOW_WORKTREE_BACKEND';

export class BootRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootRefusedError';
  }
}

// True when `p` lies inside a `.lattice/worktrees/` directory: the home-scoped
// `~/.lattice/worktrees/<hash>/…` checkouts AND the legacy in-repo
// `<repo>/.lattice/worktrees/…` ones. Matched by path segment, not by
// `os.homedir()`, so it still fires when HOME is redirected.
export function isInsideLatticeWorktree(p: string): boolean {
  const segments = path.resolve(p).split(/[\\/]+/).map((s) => s.toLowerCase());
  for (let i = 0; i < segments.length - 2; i++) {
    if (segments[i] === '.lattice' && segments[i + 1] === 'worktrees') return true;
  }
  return false;
}

/**
 * Refusal message when this backend's code or cwd is inside a Lattice task
 * worktree, else null. Both are checked: an agent can run the MAIN checkout's
 * `dist/index.js` from its worktree cwd, and the worktree's own copy from
 * anywhere.
 */
export function worktreeBootRefusal(opts: {
  codeDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): string | null {
  if (opts.env[ALLOW_WORKTREE_BACKEND_ENV] === '1') return null;
  const where = [opts.codeDir, opts.cwd].find(isInsideLatticeWorktree);
  if (!where) return null;
  return (
    `refusing to start: this backend is running from a Lattice task worktree (${where}). ` +
    'A backend started there shares the live instance\'s ~/.lattice state (task DBs, snapshots, ' +
    'the terminal-server) and its startup recovery would mutate it. Task agents must not start ' +
    'the Lattice backend or `npm run dev`. For a deliberately isolated instance, point ' +
    'HOME/USERPROFILE at a scratch dir, pick free PORT/TERMINAL_PORT values, and set ' +
    `${ALLOW_WORKTREE_BACKEND_ENV}=1.`
  );
}

export type PortState = 'free' | 'in-use' | 'unknown';

// Can this process bind `host:port` right now? A throwaway listener is bound
// and immediately closed. Unlike a connect probe (which on Windows takes ~2 s
// to be refused on loopback) this answers in milliseconds on the common path.
export function probePortBindable(port: number, host = '127.0.0.1'): Promise<PortState> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' ? 'in-use' : 'unknown');
    });
    probe.listen(port, host, () => {
      probe.close(() => resolve('free'));
    });
  });
}

// Whoever holds the port: a Lattice backend answers /api/health with {ok:true}.
export async function identifyListener(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'lattice' | 'other'> {
  try {
    const res = await fetchImpl(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { ok?: unknown } | null;
    return res.ok && body?.ok === true ? 'lattice' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Refusal message when the backend port is already held, else null.
 *
 * Check-then-recover, not a held claim: the real `listen()` still happens only
 * after startup recovery (the API must stay closed while recovery runs — see
 * startup.ts). A second backend that starts in the few seconds between this
 * check and that listen is not caught here; it is the case this check exists
 * for — a stray backend started next to a long-running live one — that is.
 */
export async function liveBackendRefusal(
  port: number,
  deps: {
    probe?: (port: number) => Promise<PortState>;
    identify?: (origin: string) => Promise<'lattice' | 'other'>;
  } = {},
): Promise<string | null> {
  const state = await (deps.probe ?? probePortBindable)(port);
  // 'unknown' (EACCES, …): let the real listen() report it as it always has.
  if (state !== 'in-use') return null;
  const origin = `http://127.0.0.1:${port}`;
  const who = await (deps.identify ?? identifyListener)(origin);
  return who === 'lattice'
    ? `refusing to start: another Lattice backend is already serving ${origin}. ` +
        'Starting a second one would run startup recovery against the live instance\'s ' +
        '~/.lattice state before failing to bind. Use the running instance, or stop it first.'
    : `refusing to start: port ${port} is already in use by another process ` +
        '(it does not answer /api/health as a Lattice backend). Free the port, or set PORT.';
}

/**
 * Run every pre-boot refusal. Resolves when the backend may proceed; throws a
 * `BootRefusedError` (message only, no stack worth printing) when it may not.
 */
export async function runBootGuards(opts: {
  port: number;
  codeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  liveBackend?: (port: number) => Promise<string | null>;
}): Promise<void> {
  const worktree = worktreeBootRefusal({
    codeDir: opts.codeDir ?? path.dirname(fileURLToPath(import.meta.url)),
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
  });
  if (worktree) throw new BootRefusedError(worktree);
  const live = await (opts.liveBackend ?? liveBackendRefusal)(opts.port);
  if (live) throw new BootRefusedError(live);
}
