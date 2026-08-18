import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The dev runner's side of crash logging.
//
// The backend and terminal-server write their own crash files (see
// backend/src/crashLog.ts), but that only covers deaths those processes are
// alive to observe. A `taskkill`, an OS OOM-kill, or vite falling over leaves
// no trace at all — and `npm run dev` output lives only in the user's terminal,
// which is gone by the time anyone asks what happened. So: keep the tail of
// each child's output in memory and, whenever a child exits abnormally, append
// it to ~/.lattice/logs/dev-runner.log.

const TAIL_LINES = 80;
const MAX_LOG_BYTES = 512 * 1024;

const tails = new Map();

export function logsDir() {
  return path.join(os.homedir(), '.lattice', 'logs');
}

export function recordOutput(label, line) {
  let tail = tails.get(label);
  if (!tail) {
    tail = [];
    tails.set(label, tail);
  }
  tail.push(line);
  if (tail.length > TAIL_LINES) tail.shift();
}

// Append one record. `expected` marks a shutdown we asked for, which is logged
// as a one-liner without the output tail.
export function recordExit(label, code, { expected = false } = {}) {
  const when = new Date().toISOString();
  const header = `${when} [${label}] exited code=${code}${expected ? ' (shutdown requested)' : ''}`;
  const tail = expected ? [] : (tails.get(label) ?? []);
  const body = tail.length
    ? `${header}\n--- last ${tail.length} lines ---\n${tail.join('\n')}\n\n`
    : `${header}\n`;
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'dev-runner.log');
    // Cheap rotation so an endless crash loop can't grow the file forever.
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* no existing log, or rotation raced — either way just append */
    }
    fs.appendFileSync(file, body, 'utf8');
    return file;
  } catch {
    return null; // logging must never break the dev runner
  }
}
