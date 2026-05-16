import os from 'node:os';
import { spawn } from 'node:child_process';

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
export function killProcessTreeWindows(pid: number): void {
  if (!isWindows || !pid) return;
  try {
    const child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    // Swallow the inevitable ENOENT / exit-1 (PID already gone) without
    // polluting the log, and drop the handle from the event loop so the
    // parent doesn't wait on it.
    child.on('error', () => { /* ignore */ });
    child.unref();
  } catch {
    /* spawn itself failed — process may already be gone */
  }
}
