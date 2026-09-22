import { spawn } from 'node:child_process';

export type ExecResult = { stdout: string; stderr: string; code: number };

// After a timeout kill, how long to wait for 'close' before resolving anyway
// (see the timer below). Exported for the regression test.
export const EXEC_KILL_GRACE_MS = 2_000;

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
    let graceTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;
    const settle = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(r);
    };
    const timedOutResult = (code: number | null): ExecResult => ({
      stdout,
      stderr: stderr + `\n[exec] killed after ${opts?.timeoutMs}ms timeout`,
      code: code ?? 124,
    });
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
        // 'close' waits for every holder of the stdio pipes, not just the
        // child. A grandchild that inherited them (a git hook, a credential
        // helper, a pager) survives the kill and would keep 'close' — and so
        // this promise, and the cleanup/merge awaiting it — pending until it
        // exits on its own. The timeout must actually bound the call.
        graceTimer = setTimeout(() => settle(timedOutResult(null)), EXEC_KILL_GRACE_MS);
        graceTimer.unref?.();
      }, opts.timeoutMs);
    }
    // Decode through a StringDecoder (setEncoding), never chunk-by-chunk: a
    // multi-byte UTF-8 path (`ls-files -z`, `worktree list -z`) split across
    // two pipe reads would otherwise decode as U+FFFD garbage on both sides
    // and silently stop matching the real path.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    // 'close' fires with (code, signal). A process terminated by a signal
    // arrives with code===null and signal set; reporting it as exit 0 would
    // let a signal-killed `git rev-list --count` (POSIX SIGKILL/OOM, an
    // external kill, a git crash-by-signal) masquerade as a successful empty
    // result — and countBetween, which throws on non-zero precisely so a
    // transient git failure is never misread as '0 commits', would instead
    // see {code:0, stdout:''}, parse NaN→0, and strand a task's commits
    // unmerged. So a signal death MUST surface as a non-zero code.
    child.on('close', (code, signal) => {
      if (timedOut) {
        settle(timedOutResult(code));
      } else {
        settle({ stdout, stderr, code: code ?? (signal ? 137 : 1) });
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(err);
    });
  });
}
