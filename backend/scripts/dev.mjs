#!/usr/bin/env node
// Wraps `tsx watch src/index.ts` and filters one specific block of stderr
// noise:
//
//   .../node-pty/src/conpty_console_list_agent.ts:13
//   const consoleProcessList = getConsoleProcessList(shellPid);
//                              ^
//   Error: AttachConsole failed
//       at ...
//   Node.js v22.18.0
//
// Why: tsx watch sets NODE_OPTIONS=--import .../tsx/dist/loader.mjs which
// every child_process.spawn() inherits. node-pty forks a small helper
// (conpty_console_list_agent) per pty on Windows; the inherited tsx loader
// resolves it to the .ts source in node-pty/src/ instead of the compiled
// .js in node-pty/lib/. The .ts source crashes at module load. The crash
// is benign — node-pty handles the helper failure, terminals still work —
// but the stderr block is loud. We strip it here and forward everything
// else verbatim so legitimate backend errors are still visible.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const NOISE_START =
  /AttachConsole failed|conpty_console_list_agent|getConsoleProcessList\(shellPid\)/;
const NOISE_END = /^Node\.js v/;

// Resolve tsx's actual JS entrypoint and run it with the same Node binary.
// This avoids the .cmd shim (which Node 20+ refuses to spawn without a
// shell) and bypasses the npx layer entirely. We resolve via package.json
// because tsx's `dist/cli.mjs` isn't listed in its package exports map.
import path from 'node:path';
const require = createRequire(import.meta.url);
const tsxPkgJson = require.resolve('tsx/package.json');
const tsxCliPath = path.join(path.dirname(tsxPkgJson), 'dist', 'cli.mjs');

const child = spawn(
  process.execPath,
  [tsxCliPath, 'watch', 'src/index.ts'],
  { stdio: ['inherit', 'inherit', 'pipe'], shell: false },
);

let buffer = '';
let suppressing = false;

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) emit(line);
});

child.on('exit', (code, signal) => {
  if (buffer) emit(buffer);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

function emit(line) {
  if (!suppressing && NOISE_START.test(line)) {
    suppressing = true;
    return;
  }
  if (suppressing) {
    if (NOISE_END.test(line)) {
      suppressing = false;
    }
    return;
  }
  process.stderr.write(line + '\n');
}

// Forward Ctrl+C cleanly to the child.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  });
}
