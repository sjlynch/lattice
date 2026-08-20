import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stdoutSink } from './consoleSink.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.dirname(path.dirname(HERE));
export const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export const HEALTH_URL = 'http://127.0.0.1:5184/api/health';
export const HEALTH_TIMEOUT_MS = 30_000;
export const HEALTH_POLL_INTERVAL_MS = 200;

export const COLORS = {
  backend: '\x1b[36m', // cyan
  frontend: '\x1b[35m', // magenta
  lattice: '\x1b[33m', // yellow
  reset: '\x1b[0m',
};

export function note(msg) {
  stdoutSink.write(`${COLORS.lattice}[lattice]${COLORS.reset} ${msg}\n`);
}
