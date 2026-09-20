import { spawn } from 'node:child_process';

import { npmCmd, ROOT } from './config.mjs';
import { stderrSink, stdoutSink } from './consoleSink.mjs';
import { prefixLines } from './logFilter.mjs';

export function startChild(
  label,
  color,
  args,
  { filterViteProxy = false, cwd = ROOT } = {},
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
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: win,
    env: process.env,
  });

  // Sinks, not process.stdout/stderr: a blocking console write here would stop
  // this process draining the pipes below, which freezes the children. See
  // consoleSink.mjs.
  prefixLines(child.stdout, stdoutSink, { label, color, filterViteProxy });
  prefixLines(child.stderr, stderrSink, { label, color, filterViteProxy });

  return child;
}

export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // npm.cmd spawns node as a child; SIGTERM on the .cmd doesn't kill
    // the descendants. taskkill /T walks the tree.
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
  } else {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}
