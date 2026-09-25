import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stdoutSink } from './consoleSink.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.dirname(path.dirname(HERE));
export const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Each child is started with its own cwd rather than `npm --prefix <dir> run`.
// Both forms run the script with cwd = the package dir, but `--prefix` ALSO
// sets npm's `prefix` config — whose primary meaning is "the location to
// install global items". npm exports its whole resolved config to every
// run-script as `npm_config_*`, and the backend hands its environment
// wholesale to every pty it spawns, so `--prefix backend` made
// `npm install -g <pkg>` in ANY Lattice terminal, in ANY project, install into
// `<latticeRoot>/backend` instead of the user's real global prefix. See
// `backend/src/terminal/envSetup.ts` for the matching defence at the pty
// boundary. Do not reintroduce `--prefix` here.
export const BACKEND_DIR = path.join(ROOT, 'backend');
export const FRONTEND_DIR = path.join(ROOT, 'frontend');

// `PORT` is the backend's own override (backend/src/server/config.ts); the dev
// runner's lifecycle + restart handshake read it too, so a stack started on
// alternate ports (an isolated test stack) waits on its own backend.
export const HEALTH_URL = `http://127.0.0.1:${Number(process.env.PORT) || 5184}/api/health`;
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
