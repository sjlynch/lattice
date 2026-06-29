// Shared authentication material for the detached terminal-server HTTP API.
//
// The server is loopback-bound, but browser pages can still form-POST to
// 127.0.0.1. Mutating routes therefore require a backend-only bearer token in a
// custom header (forms cannot add it, and cross-site fetches cannot read it).
// The token is persisted so the main backend can reconnect to an already-running
// detached terminal-server after a dev/backend restart while preserving PTYs.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { latticeHomeDir } from './projectPath.js';

export const TERMINAL_SERVER_TOKEN_ENV = 'LATTICE_TERMINAL_TOKEN';
export const TERMINAL_SERVER_AUTH_HEADER = 'x-lattice-terminal-token';

const TOKEN_BYTES = 32;
const TOKEN_FILE = 'terminalServerToken';

let cachedToken: string | null = null;

function tokenFilePath(): string {
  return path.join(latticeHomeDir(), TOKEN_FILE);
}

function validToken(token: string): boolean {
  // 32 random bytes encoded as base64url is 43 chars; accept longer future
  // encodings so a later widening does not strand a running server.
  return token.length >= 32;
}

export function getTerminalServerAuthToken(): string {
  if (cachedToken) return cachedToken;
  const file = tokenFilePath();
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (validToken(existing)) {
      cachedToken = existing;
      return existing;
    }
  } catch {
    /* absent or unreadable — fall through and create one */
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    mkdirSync(latticeHomeDir(), { recursive: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    chmodSync(file, 0o600); // best-effort owner-only (inert on Windows)
  } catch (err) {
    // Degrade to a process-lifetime token if the home scratch area is
    // unavailable. Existing PTYs may not survive a backend restart in this rare
    // mode, but the mutating API remains protected for this process.
    console.warn('[terminal-auth] could not persist terminal-server token:', err);
  }
  cachedToken = token;
  return token;
}

export function terminalServerAuthHeaders(): Record<string, string> {
  return { [TERMINAL_SERVER_AUTH_HEADER]: getTerminalServerAuthToken() };
}

export function tokenMatches(expected: string, got: string | undefined): boolean {
  if (!expected || !got) return false;
  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(got);
  return expectedBuf.length === gotBuf.length && timingSafeEqual(expectedBuf, gotBuf);
}
