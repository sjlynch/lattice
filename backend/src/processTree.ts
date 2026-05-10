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
// fire it AFTER pty.kill so the conpty handle is already torn down, then
// detach so we don't block the caller waiting for taskkill to finish.
export function killProcessTreeWindows(pid: number): void {
  if (!isWindows || !pid) return;
  try {
    const child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    // Detach so we don't keep a handle; swallow the inevitable ENOENT/
    // exit-1 (PID already gone) without polluting the log.
    child.on('error', () => { /* ignore */ });
    child.unref();
  } catch {
    /* spawn itself failed — process may already be gone */
  }
}
