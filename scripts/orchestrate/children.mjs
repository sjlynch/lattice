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
  const child = spawn(npmCmd, args, {
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
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
