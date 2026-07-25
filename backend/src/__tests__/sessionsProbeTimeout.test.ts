import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Regression for: proxyListSessions / proxyKillSession used to fetch the
// detached terminal-server with NO AbortSignal.timeout, so a wedged server
// whose socket is accepted but never answered would hang the awaiting caller
// (workflow advance, post-merge abort, DELETE /api/terminals/:id, GET
// /api/terminals) forever. They must now settle fast on the shared 3s probe
// timeout, like their siblings proxyCountSessions / proxyListSessionsOrNull /
// proxyKillSessionsByCwd.
//
// A raw TCP server that accepts connections but never writes a byte models the
// wedged terminal-server: the fetch connects (socket accepted) but never
// receives an HTTP response, so only AbortSignal.timeout can end it. TERMINAL_PORT
// is pointed at this fake server BEFORE the first import of the module under
// test, because BASE is captured from that env var at module-load time (and
// `node --test` runs each test file in its own process).

const SESSIONS_PROBE_TIMEOUT_MS = 3_000;
// Lower bound proves the socket was accepted and the *timeout* drove the settle
// (a connection-refused would resolve near-instantly and wouldn't exercise the
// fix); upper bound proves it didn't hang. Generous margins for slow CI.
const SETTLE_FLOOR_MS = 2_500;
const SETTLE_CEIL_MS = 8_000;

let server: net.Server;
const accepted: net.Socket[] = [];

before(async () => {
  server = net.createServer((sock) => {
    // Accept the connection, then intentionally never respond.
    accepted.push(sock);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.env.TERMINAL_PORT = String(port);
});

after(() => {
  for (const s of accepted) s.destroy();
  server?.close();
});

test('proxyListSessions settles (returns []) instead of hanging on a wedged server', {
  timeout: 15_000,
}, async () => {
  const { proxyListSessions } = await import('../terminalServerClient/sessions.js');
  const start = performance.now();
  const result = await proxyListSessions();
  const elapsed = performance.now() - start;
  assert.deepEqual(result, [], 'unreachable/wedged server should yield an empty list');
  assert.ok(
    elapsed >= SETTLE_FLOOR_MS && elapsed < SETTLE_CEIL_MS,
    `expected the ${SESSIONS_PROBE_TIMEOUT_MS}ms probe timeout to drive the settle, took ${Math.round(elapsed)}ms`,
  );
});

test('proxyKillSession settles (returns false = kill-unconfirmed) instead of hanging', {
  timeout: 15_000,
}, async () => {
  const { proxyKillSession } = await import('../terminalServerClient/sessions.js');
  const start = performance.now();
  const result = await proxyKillSession('sess_wedged');
  const elapsed = performance.now() - start;
  assert.equal(result, false, 'a timed-out kill must report unconfirmed (false)');
  assert.ok(
    elapsed >= SETTLE_FLOOR_MS && elapsed < SETTLE_CEIL_MS,
    `expected the ${SESSIONS_PROBE_TIMEOUT_MS}ms probe timeout to drive the settle, took ${Math.round(elapsed)}ms`,
  );
});
