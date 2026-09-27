// Shared authentication material for the detached terminal-server HTTP API.
//
// The server is loopback-bound, but browser pages can still form-POST to
// 127.0.0.1. Mutating routes therefore require a backend-only bearer token in a
// custom header (forms cannot add it, and cross-site fetches cannot read it).
// The token is persisted so the main backend can reconnect to an already-running
// detached terminal-server after a dev/backend restart while preserving PTYs.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { latticeHomeDir } from './projectPath.js';
import { loadOrCreatePersistedSecret } from './persistedSecretFile.js';

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

// Throws (uncached, so the next call retries) when the token file exists but
// stays unreadable: minting a replacement would lock this backend out of the
// running detached terminal-server, which still holds the old token.
export function getTerminalServerAuthToken(): string {
  if (cachedToken) return cachedToken;
  let result;
  try {
    result = loadOrCreatePersistedSecret({
      file: tokenFilePath(),
      label: '[terminal-auth]',
      parse: (raw) => {
        const token = raw.toString('utf8').trim();
        return validToken(token) ? token : null;
      },
      generate: () => {
        const token = randomBytes(TOKEN_BYTES).toString('base64url');
        return { value: token, bytes: `${token}\n` };
      },
    });
  } catch (err) {
    console.error('[terminal-auth] terminal-server token unavailable:', err);
    throw err;
  }
  // `persisted: false` = a process-lifetime token (home scratch area not
  // writable). Existing PTYs may not survive a backend restart in this rare
  // mode, but the mutating API remains protected for this process.
  cachedToken = result.value;
  return result.value;
}

export function resetTerminalServerAuthTokenForTests(): void {
  cachedToken = null;
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
