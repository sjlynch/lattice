import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const isWindows = os.platform() === 'win32';

// Windows has no process groups, so `pty.kill()` (which closes the conpty
// and signals the spawned shell) leaves the shell's children — and their
// children — running. Powershell exits, but `claude` (a node child) keeps
// going, and after a few run/qa cycles you have dozens of orphan Claude
// processes munching CPU/RAM.
//
// `taskkill /F /T /PID <pid>` walks and force-kills the whole tree. We
// fire it AFTER pty.kill so the conpty handle is already torn down.
//
// No `detached: true` on purpose. taskkill.exe is a console-subsystem app;
// `detached: true` requests a new console session for the child, and the
// `DETACHED_PROCESS` + `CREATE_NO_WINDOW` combination Windows ends up
// with is racy — the new console briefly flashes on screen before being
// hidden. The terminal-server is itself spawned detached/stdio:ignore
// from the main backend, so it has no attached console; a child spawned
// without `detached: true` inherits that "no console" state and Windows
// never allocates one at all. `stdio: 'ignore'` + `child.unref()` is
// what actually keeps the caller from blocking on taskkill's exit;
// `detached` controls OS-level process grouping, not JS-level waiting.
//
// `onSpawnError` runs if taskkill itself can't start (default: ignore).
export function killProcessTreeWindows(
  pid: number,
  opts: { onSpawnError?: () => void } = {},
): void {
  if (!isWindows || !pid) return;
  try {
    const child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    // Swallow the inevitable ENOENT / exit-1 (PID already gone) without
    // polluting the log, and drop the handle from the event loop so the
    // parent doesn't wait on it.
    child.on('error', () => {
      opts.onSpawnError?.();
    });
    child.unref();
  } catch {
    /* spawn itself failed — process may already be gone */
  }
}

// Kill a `child_process` child — and, for a `shell: true` spawn, everything
// under it. `child.kill()` only reaches the process we spawned; behind a shell
// that is cmd.exe / sh, and the real work is its grandchild, which would
// survive holding our stdio pipes. win32: taskkill walks the tree
// (fire-and-forget; falls back to child.kill() if taskkill itself can't
// start). POSIX: the caller must have spawned the shell child `detached` (its
// own process group), so one negative-pid signal takes the whole tree. A
// non-shell spawn keeps the plain child.kill(). Never throws.
export function killChildTree(child: ChildProcess, opts: { shell: boolean }): void {
  try {
    if (!opts.shell || child.pid === undefined) {
      child.kill();
      return;
    }
    if (process.platform === 'win32') {
      killProcessTreeWindows(child.pid, {
        onSpawnError: () => {
          try {
            child.kill();
          } catch {
            /* already exited */
          }
        },
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* already exited */
  }
}
