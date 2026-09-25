// The `npm install` child-process runner behind the post-boot dependency
// watcher (`depsWatch.mjs`, which re-exports the public pieces — import them
// from there): spawning, output capture, tree kill, and classifying a failure
// into an actionable hint.
//
// Install with cwd = the workspace, never `--prefix` (see scripts/CLAUDE.md).

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { recordOutput } from './orchestrate/devLog.mjs';

const MAX_OUTPUT_CHARS = 64 * 1024;

/** Pure: was an install failure a locked file, and was that file node-pty's? */
export function classifyInstallFailure(output) {
  const text = String(output ?? '');
  const locked = /\b(EBUSY|EPERM)\b/.test(text);
  return { locked, nodePty: locked && /node-pty/i.test(text) };
}

/** Pure: the actionable next step for a failed install. */
export function installFailureHint({ locked, nodePty }, platform = process.platform) {
  if (nodePty) {
    return (
      "node-pty's native module is loaded by the detached terminal-server that hosts every agent terminal" +
      (platform === 'win32' ? ", and Windows won't replace a loaded .node file" : '') +
      '. A soft restart (`r`) keeps that server alive, so it cannot free the file: when your agents are ' +
      'idle, Ctrl+C and run `npm run dev` again (preflight installs before anything loads node-pty). ' +
      'The running stack stays on the old dependencies meanwhile.'
    );
  }
  if (locked) {
    return (
      'a file under node_modules is held open by a running process (the backend, vite/esbuild, an editor ' +
      'or antivirus). A soft restart (`r` in the npm run dev console) stops the backend and vite while ' +
      'keeping agents running, and re-runs the install in preflight; or type `i` to retry.'
    );
  }
  return (
    'see the npm output above. Nothing retries automatically until package.json / package-lock.json ' +
    'change again; type `i` in the npm run dev console to retry sooner.'
  );
}

// Kill an install and everything it started (node-gyp, postinstall scripts).
// None of it is an ancestor of the terminal-server, so a tree kill is safe.
function killInstallTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode != null) return;
  if (platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/**
 * Run `npm install` in `cwd`. Output is forwarded line by line, kept in the
 * dev-runner log tail under `recordLabel`, and returned (bounded) so the caller
 * can classify a failure.
 * @returns {{ done: Promise<{ code: number, output: string }>, kill(): void }}
 */
export function runNpmInstall({
  cwd,
  recordLabel,
  forward = (line, stream) => process[stream].write(`${line}\n`),
  spawnProcess = spawn,
  platform = process.platform,
}) {
  // On Windows npm is a .cmd shim that only a shell can launch: ONE constant
  // command string, never args + shell:true (DEP0190).
  const win = platform === 'win32';
  let child = null;
  let output = '';
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      resolve({ code, output: output + extra });
    };
    try {
      child = spawnProcess(win ? 'npm install' : 'npm', win ? [] : ['install'], {
        cwd,
        // Never the dev runner's stdin: under the orchestrator that is the
        // control pipe, and a child reading it would swallow commands.
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: win,
        windowsHide: true,
      });
    } catch (err) {
      finish(1, String(err?.message ?? err));
      return;
    }
    for (const stream of ['stdout', 'stderr']) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const emit = (line) => {
        recordOutput(recordLabel, line);
        output = (output + line + '\n').slice(-MAX_OUTPUT_CHARS);
        try {
          forward(line, stream);
        } catch {
          /* logging must never break the runner */
        }
      };
      child[stream]?.on('data', (chunk) => {
        pending += decoder.write(chunk);
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          emit(pending.slice(0, end).replace(/\r$/, ''));
          pending = pending.slice(end + 1);
        }
      });
      child[stream]?.on('end', () => {
        pending += decoder.end();
        if (pending) emit(pending);
        pending = '';
      });
    }
    // 'close', not 'exit': the output classification needs the final lines.
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (err) => finish(1, String(err?.message ?? err)));
  });
  return { done, kill: () => killInstallTree(child, platform) };
}
