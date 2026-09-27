// Regression: a transiently unreadable ~/.lattice/terminalServerToken (EBUSY /
// EPERM from AV, backup or the indexer on Windows) used to be treated like an
// absent one — the backend minted and persisted a NEW token, while the detached
// terminal-server kept the old one, so every authenticated call 401'd until all
// agents were killed. agentTokenSecret had the same pattern and silently
// invalidated every HMAC activity token baked into project hooks.
//
// Now only ENOENT (create exclusively, re-reading on EEXIST) or an unusable
// value regenerates; any other read error retries briefly, then fails without
// writing.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getTerminalServerAuthToken,
  resetTerminalServerAuthTokenForTests,
} from '../terminalServerAuth.js';
import {
  decodeAgentToken,
  encodeAgentToken,
  resetAgentTokenSecretForTests,
} from '../agentActivityTokens.js';
import { SecretFileUnreadableError } from '../persistedSecretFile.js';

if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error(
    'persistedSecretFile.test.ts writes under ~/.lattice — run it via `npm test` (or with ' +
      '`--import ./src/__tests__/helpers/isolateHome.mjs`), never bare `node --test`.',
  );
}

const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;

function homeFile(name: string): string {
  return path.join(os.homedir(), '.lattice', name);
}

function samePath(a: unknown, b: string): boolean {
  return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// Stub fs.readFileSync for `file` only: `failures` is consumed one per read
// (an error code to throw, or null to fall through to the real read); once
// exhausted, `rest` applies ('real' or an error code for every further read).
function stubReads(
  t: TestContext,
  file: string,
  failures: (string | null)[],
  rest: 'real' | string = 'real',
): { reads: () => number } {
  let reads = 0;
  t.mock.method(fs, 'readFileSync', ((...args: unknown[]) => {
    if (samePath(args[0], file)) {
      const step = reads < failures.length ? failures[reads] : rest === 'real' ? null : rest;
      reads++;
      if (step) throw errno(step);
    }
    return (realRead as (...a: unknown[]) => unknown).apply(fs, args);
  }) as unknown as typeof fs.readFileSync);
  return { reads: () => reads };
}

function spyWrites(t: TestContext, file: string): { writes: () => number } {
  let writes = 0;
  t.mock.method(fs, 'writeFileSync', ((...args: unknown[]) => {
    if (samePath(args[0], file)) writes++;
    return (realWrite as (...a: unknown[]) => unknown).apply(fs, args);
  }) as unknown as typeof fs.writeFileSync);
  return { writes: () => writes };
}

function seed(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  realWrite(file, content);
}

const EXISTING_TOKEN = 'existing-terminal-token-0123456789abcdefghijk';

test('terminal token: a persistently unreadable file throws and is never rewritten', (t) => {
  const file = homeFile('terminalServerToken');
  seed(file, `${EXISTING_TOKEN}\n`);
  resetTerminalServerAuthTokenForTests();
  t.after(resetTerminalServerAuthTokenForTests);
  t.mock.method(console, 'error', () => {});
  const r = stubReads(t, file, [], 'EBUSY');
  const w = spyWrites(t, file);

  assert.throws(() => getTerminalServerAuthToken(), SecretFileUnreadableError);
  assert.ok(r.reads() > 1, 'retries before giving up');
  assert.equal(w.writes(), 0);
  assert.equal(realRead(file, 'utf8'), `${EXISTING_TOKEN}\n`);

  // Not cached as a failure: once the file is readable again the original
  // token comes back.
  t.mock.restoreAll();
  assert.equal(getTerminalServerAuthToken(), EXISTING_TOKEN);
});

test('terminal token: a transient EBUSY/EPERM is retried and the existing token kept', (t) => {
  const file = homeFile('terminalServerToken');
  seed(file, `${EXISTING_TOKEN}\n`);
  resetTerminalServerAuthTokenForTests();
  t.after(resetTerminalServerAuthTokenForTests);
  stubReads(t, file, ['EBUSY', 'EPERM']);
  const w = spyWrites(t, file);

  assert.equal(getTerminalServerAuthToken(), EXISTING_TOKEN);
  assert.equal(w.writes(), 0);
});

test('terminal token: ENOENT still creates one', (t) => {
  const file = homeFile('terminalServerToken');
  fs.rmSync(file, { force: true });
  resetTerminalServerAuthTokenForTests();
  t.after(resetTerminalServerAuthTokenForTests);

  const token = getTerminalServerAuthToken();
  assert.ok(token.length >= 32);
  assert.equal(realRead(file, 'utf8').trim(), token);
});

test('terminal token: losing an EEXIST create race re-reads the winner', (t) => {
  const file = homeFile('terminalServerToken');
  const winner = 'winner-terminal-token-0123456789abcdefghijklmn';
  // The file exists (the other creator won), but our first read raced it.
  seed(file, `${winner}\n`);
  resetTerminalServerAuthTokenForTests();
  t.after(resetTerminalServerAuthTokenForTests);
  stubReads(t, file, ['ENOENT']);

  assert.equal(getTerminalServerAuthToken(), winner);
  assert.equal(realRead(file, 'utf8'), `${winner}\n`);
});

test('terminal token: a too-short value is replaced', (t) => {
  const file = homeFile('terminalServerToken');
  seed(file, 'short\n');
  resetTerminalServerAuthTokenForTests();
  t.after(resetTerminalServerAuthTokenForTests);

  const token = getTerminalServerAuthToken();
  assert.notEqual(token, 'short');
  assert.ok(token.length >= 32);
  assert.equal(realRead(file, 'utf8').trim(), token);
});

test('agent token secret: an unreadable file is never rewritten; tokens still work in-process', (t) => {
  const file = homeFile('agentTokenSecret');
  const secret = Buffer.alloc(32, 7);
  seed(file, secret);
  resetAgentTokenSecretForTests();
  t.after(resetAgentTokenSecretForTests);
  t.mock.method(console, 'error', () => {});
  stubReads(t, file, [], 'EBUSY');
  const w = spyWrites(t, file);

  const payload = { agentId: 'a1', projectPath: '/p', label: 'claude' };
  assert.deepEqual(decodeAgentToken(encodeAgentToken(payload)), payload);
  assert.equal(w.writes(), 0);
  assert.deepEqual(realRead(file), secret);
});

test('agent token secret: a transient read error keeps the persisted secret', (t) => {
  const file = homeFile('agentTokenSecret');
  seed(file, Buffer.alloc(32, 9));
  const payload = { agentId: 'a2', projectPath: '/p', label: 'codex' };

  resetAgentTokenSecretForTests();
  t.after(resetAgentTokenSecretForTests);
  const baked = encodeAgentToken(payload); // minted under the persisted secret

  resetAgentTokenSecretForTests(); // a "restart" that hits a busy file
  stubReads(t, file, ['EBUSY']);
  const w = spyWrites(t, file);
  assert.deepEqual(decodeAgentToken(baked), payload);
  assert.equal(w.writes(), 0);
});
