import { spawn } from 'node:child_process';

export type ExecResult = { stdout: string; stderr: string; code: number };

// Spawn a command, capture stdout/stderr, and resolve with the exit code.
// `timeoutMs` SIGKILLs the child if it runs too long — required for the
// cleanup path on Windows, where a process holding a worktree dir open
// could otherwise wedge `git worktree remove` indefinitely.
export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    // 'close' fires with (code, signal). A process terminated by a signal
    // arrives with code===null and signal set; reporting it as exit 0 would
    // let a signal-killed `git rev-list --count` (POSIX SIGKILL/OOM, an
    // external kill, a git crash-by-signal) masquerade as a successful empty
    // result — and countBetween, which throws on non-zero precisely so a
    // transient git failure is never misread as '0 commits', would instead
    // see {code:0, stdout:''}, parse NaN→0, and strand a task's commits
    // unmerged. So a signal death MUST surface as a non-zero code.
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({
          stdout,
          stderr: stderr + `\n[exec] killed after ${opts?.timeoutMs}ms timeout`,
          code: code ?? 124,
        });
      } else {
        resolve({ stdout, stderr, code: code ?? (signal ? 137 : 1) });
      }
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
