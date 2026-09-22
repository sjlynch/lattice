// One small shared "spawn a child process with a timeout and capture output"
// helper. Two call sites need exactly this pattern: Pi model discovery
// (`piModels` — `pi --list-models`) and the Pi sub-agents auto-install
// (`piSubagents` — `pi install … -l`). Both spawn a CLI, accumulate stdout /
// stderr, kill the child if it runs past a deadline, and resolve a structured
// result instead of throwing. Each caller maps that result to its own
// success/failure shape (one wants the captured text; the other wants
// resolve-on-exit-0 / reject-otherwise).

import { spawn, type ChildProcess } from 'node:child_process';

export type SpawnWithTimeoutResult = {
  // Process exit code, or null if it was killed (timeout) or never spawned.
  code: number | null;
  stdout: string;
  stderr: string;
  // stdout+stderr concatenated in arrival order — for callers that parse the
  // combined stream (Pi prints its model table to stderr, not stdout).
  combined: string;
  // True if the timeout fired and we killed the child.
  timedOut: boolean;
  // True if the caller's AbortSignal fired and we killed the child.
  aborted?: boolean;
  // A spawn-level error (e.g. ENOENT when the binary is missing), else null.
  // Never thrown — surfaced here so the caller decides how to react.
  error: Error | null;
};

// Resolves (never rejects) once the child exits, errors, or the timeout fires.
// On timeout the child is killed and the result is returned immediately rather
// than waiting for the (possibly stuck) close — matching the prior inline
// implementations.
export function spawnWithTimeout(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    shell?: boolean;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    // Optional cancellation: aborting kills the child and resolves with
    // `aborted: true` (an already-aborted signal resolves without spawning).
    signal?: AbortSignal;
  },
): Promise<SpawnWithTimeoutResult> {
  return new Promise((resolve) => {
    let settled = false;
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', combined: '', timedOut: false, aborted: true, error: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    let combined = '';
    const finish = (r: SpawnWithTimeoutResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const useShell = opts.shell ?? false;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        shell: useShell,
        windowsHide: true,
        // POSIX shell spawns get their own process group so the timeout can
        // signal the WHOLE tree (see killChild). Not on win32, where a tree
        // kill goes through taskkill and `detached` would only add a console.
        detached: useShell && process.platform !== 'win32',
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch (err) {
      finish({
        code: null,
        stdout: '',
        stderr: '',
        combined: '',
        timedOut: false,
        error: err as Error,
      });
      return;
    }

    child.stdout?.on('data', (d) => {
      const s = String(d);
      stdout += s;
      combined += s;
    });
    child.stderr?.on('data', (d) => {
      const s = String(d);
      stderr += s;
      combined += s;
    });

    // Kill the child — and, for a `shell: true` spawn, everything under it.
    // `child.kill()` only reaches the process we spawned; behind a shell that is
    // cmd.exe / sh, and the real work (`pi`, `npm install`) is its grandchild,
    // which used to survive the timeout holding our stdio pipes. win32: taskkill
    // walks the tree (fire-and-forget; falls back to child.kill() if taskkill
    // itself can't start). POSIX: the shell child is its own process group
    // (`detached` above), so one negative-pid signal takes the whole tree.
    // A non-shell spawn keeps the plain child.kill() (opengrep relies on it).
    const killChild = (): void => {
      try {
        if (!useShell || child.pid === undefined) {
          child.kill();
          return;
        }
        if (process.platform === 'win32') {
          const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          tk.on('error', () => {
            try {
              child.kill();
            } catch {
              /* already exited */
            }
          });
          tk.unref();
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        /* already exited */
      }
    };

    const timer = setTimeout(() => {
      killChild();
      finish({ code: null, stdout, stderr, combined, timedOut: true, error: null });
    }, opts.timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      killChild();
      finish({ code: null, stdout, stderr, combined, timedOut: false, aborted: true, error: null });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const detach = () => opts.signal?.removeEventListener('abort', onAbort);

    child.on('error', (err) => {
      clearTimeout(timer);
      detach();
      finish({ code: null, stdout, stderr, combined, timedOut: false, error: err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      detach();
      finish({ code, stdout, stderr, combined, timedOut: false, error: null });
    });
  });
}
