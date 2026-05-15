import { spawn } from 'node:child_process';

import { npmCmd, ROOT } from './config.mjs';
import { prefixLines } from './logFilter.mjs';

export function startChild(label, color, args, { filterViteProxy = false } = {}) {
  const child = spawn(npmCmd, args, {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,
  });

  prefixLines(child.stdout, process.stdout, { label, color, filterViteProxy });
  prefixLines(child.stderr, process.stderr, { label, color, filterViteProxy });

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
