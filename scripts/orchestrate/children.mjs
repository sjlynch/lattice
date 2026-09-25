import { spawn } from 'node:child_process';

import { npmCmd, ROOT } from './config.mjs';
import { stderrSink, stdoutSink } from './consoleSink.mjs';
import { prefixLines } from './logFilter.mjs';

export function startChild(
  label,
  color,
  args,
  { filterViteProxy = false, cwd = ROOT, stdin = 'inherit', env = process.env } = {},
) {
  // On Windows npm is a .cmd shim that only a shell can launch. Hand the shell
  // ONE command string instead of args + shell:true — that combination trips
  // Node's DEP0190 deprecation warning at every boot (twice: once per child).
  // The args are constant npm script names, never user input; refuse anything
  // else so the string can't smuggle shell syntax.
  const win = process.platform === 'win32';
  if (win && args.some((a) => !/^[\w.:-]+$/.test(a))) {
    throw new Error(`startChild: refusing to shell-join non-word argument in ${JSON.stringify(args)}`);
  }
  const child = spawn(win ? `${npmCmd} ${args.join(' ')}` : npmCmd, win ? [] : args, {
    cwd,
    // `stdin`: the orchestrator reads dev-console commands itself, so it
    // gives the backend runner a control pipe and vite an unwritten pipe (a
    // second reader of the same console would steal typed lines). See
    // devControl.mjs.
    stdio: [stdin, 'pipe', 'pipe'],
    shell: win,
    env,
  });

  // Sinks, not process.stdout/stderr: a blocking console write here would stop
  // this process draining the pipes below, which freezes the children. See
  // consoleSink.mjs.
  prefixLines(child.stdout, stdoutSink, { label, color, filterViteProxy });
  prefixLines(child.stderr, stderrSink, { label, color, filterViteProxy });

  return child;
}

// How long a Windows child gets to exit on its own before `taskkill /F`. On
// Ctrl+C every process on the console receives the break, so
// `backend/scripts/dev.mjs` is already running its own shutdown — which
// awaits the terminal-server `/shutdown` POST (2.5 s cap) before exiting.
// Force-killing its tree first lands `/F` on it mid-request and orphans the
// detached terminal-server with every pty inside it. So exceed that cap.
export const KILL_GRACE_MS = 3000;

// Resolves once the child is gone (or the force-kill was issued). On win32,
// wait up to `graceMs` for the child's own exit before `taskkill /F /T`; a
// child that had no reason to exit on its own (the other child crashed) just
// costs the grace period, which is bounded.
export function killTree(
  child,
  signal = 'SIGTERM',
  { graceMs = KILL_GRACE_MS, platform = process.platform, spawnProcess = spawn } = {},
) {
  // A child that died by a signal has `exitCode === null` but `signalCode`
  // set — without that check the win32 path waited the full grace for an
  // 'exit' that had already fired, then taskkill'd a PID the OS may reuse.
  if (!child || child.killed || child.exitCode !== null || (child.signalCode ?? null) !== null) {
    return Promise.resolve();
  }
  if (platform === 'win32' && child.pid) {
    return new Promise((resolve) => {
      let timer = null;
      const onExit = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      child.once('exit', onExit);
      timer = setTimeout(() => {
        child.off('exit', onExit);
        // npm.cmd spawns node as a child; SIGTERM on the .cmd doesn't kill
        // the descendants. taskkill /T walks the tree.
        try {
          spawnProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
          });
        } catch {
          /* ignore */
        }
        resolve();
      }, graceMs);
    });
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
  return Promise.resolve();
}
