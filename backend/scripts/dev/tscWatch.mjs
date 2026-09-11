import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { recordOutput } from '../../../scripts/orchestrate/devLog.mjs';

export function tscWatchArgs(tscBin, polling = false) {
  const args = [tscBin, '-w', '--preserveWatchOutput', '--pretty', 'false', '--locale', 'en'];
  // File polling avoids relying on native per-file notifications after a
  // watcher failure. Windows still uses recursive native DIRECTORY watches;
  // TypeScript's watchDirectory option does not override that implementation.
  if (polling) args.push('--watchFile', 'dynamicPriorityPolling', '--fallbackPolling', 'dynamicPriority');
  return args;
}

export function startTscWatch(tscBin, {
  polling = false,
  onCompileStart = () => {},
  onCompileComplete = () => {},
  spawnProcess = spawn,
  cwd,
  forwardOutput = (text, stream) => process[stream].write(text),
  recordLine = (line) => recordOutput('tsc-watch', line),
} = {}) {
  const child = spawnProcess(process.execPath, tscWatchArgs(tscBin, polling), {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let closed = false;
  let spawned = false;
  child.once('spawn', () => { spawned = true; });
  let resolveSettled;
  child.tscSettledPromise = new Promise((resolve) => { resolveSettled = resolve; });
  const complete = (result) => { resolveSettled(result); onCompileComplete(result); };
  const capturePending = [];
  child.captureTscOutputTail = () => { for (const capture of capturePending) capture(); };
  for (const stream of ['stdout', 'stderr']) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    capturePending.push(() => { if (pending) recordLine(pending.slice(-4096)); });
    const line = (raw) => {
      const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
      recordLine(text.slice(-4096));
      if (closed || stream !== 'stdout') return;
      // The locale flag fixes diagnostic text, but the clock prefix follows
      // the OS locale. Accept a clock (with optional localized day period),
      // then anchor the entire status line so quoted diagnostic text cannot
      // accidentally mark an unsuccessful compile ready.
      const status = text.replace(/^(?:[^\p{N}\r\n:()\-]{1,16}\s*)?[\p{N}]{1,2}[:.][\p{N}]{2}[:.][\p{N}]{2}(?:\s*[^\p{N}\r\n:()\-]{1,16})? - /u, '');
      if (/^(?:File change detected\. )?Starting (?:incremental compilation|compilation in watch mode)\.\.\.$/i.test(status)) onCompileStart();
      const settled = /^Found (\d+) errors?\. Watching for file changes\.$/i.exec(status);
      if (settled) complete({ successful: Number(settled[1]) === 0, errors: Number(settled[1]) });
    };
    child[stream]?.on('data', (chunk) => {
      const text = decoder.write(chunk);
      forwardOutput(text, stream);
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end).replace(/\r$/, ''));
        pending = pending.slice(end + 1);
      }
      // Bound pathological unterminated diagnostics, while retaining the tail
      // that can contain the compiler's status line split across data chunks.
      if (pending.length > 16384) {
        recordLine(pending.slice(-4096));
        pending = pending.slice(-4096);
      }
    });
    child[stream]?.on('end', () => {
      pending += decoder.end();
      if (pending) line(pending);
      pending = '';
    });
  }
  const finish = () => { closed = true; resolveSettled(null); };
  child.once('exit', finish);
  child.on('error', () => { if (!spawned) finish(); });
  return child;
}
