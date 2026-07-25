import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyCreateSession } from '../terminalServerClient/createSession.js';
import {
  BASE,
  EXPECTED_TERMINAL_FINGERPRINT,
} from '../terminalServerLifecycle.js';

// A single transient POST /sessions connection error must fail (or retry) just
// that one spawn — it must NEVER respawn the shared terminal-server, which
// shuts it down and kills every OTHER live agent's PTY mid-run. respawn() is
// only appropriate for a genuinely dead/stale server. See createSession.ts.

type FetchStub = {
  fetch: typeof fetch;
  counts: { health: number; sessions: number; shutdown: number };
};

// Build a stubbed global fetch that routes by URL + method. `healthSequence`
// gives the ProbeResult-shaping outcome for each /health call in order
// ('ok' → 200+matching fingerprint, 'dead' → thrown connection error); beyond
// the array it stays 'ok'. `sessionsThrowFirst` throws a socket-level error on
// the first POST /sessions, then returns a fresh session id.
function makeFetchStub(healthSequence: Array<'ok' | 'dead'>): FetchStub {
  const counts = { health: 0, sessions: 0, shutdown: 0 };
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/health')) {
      const outcome = healthSequence[counts.health] ?? 'ok';
      counts.health += 1;
      if (outcome === 'dead') {
        // undici surfaces a socket reset as `TypeError: fetch failed`.
        throw new TypeError('fetch failed');
      }
      return new Response(
        JSON.stringify({ ok: true, fingerprint: EXPECTED_TERMINAL_FINGERPRINT }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith('/shutdown') && method === 'POST') {
      counts.shutdown += 1;
      return new Response('', { status: 200 });
    }

    if (url.endsWith('/sessions') && method === 'POST') {
      counts.sessions += 1;
      if (counts.sessions === 1) {
        // The bug's trigger: one POST /sessions throws a connection-level error
        // (stale keep-alive socket reset) even though the server is alive.
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify({ id: 'sess_retry' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  return { fetch: fetchStub, counts };
}

test('a transient POST /sessions connection error retries the single spawn and never respawns while /health is ok', async () => {
  const original = globalThis.fetch;
  // /health is ok throughout: the initial liveness probe and the post-reset
  // re-probe both answer ok, so no respawn should ever be attempted.
  const stub = makeFetchStub(['ok', 'ok']);
  globalThis.fetch = stub.fetch;
  try {
    // No cwd → resolveHarnessSpawnBody short-circuits (no filesystem work).
    const result = await proxyCreateSession({ initialCommand: 'bash' });
    assert.deepEqual(result, { id: 'sess_retry' });
    assert.equal(
      stub.counts.shutdown,
      0,
      'must NOT POST /shutdown — respawning would kill every live PTY',
    );
    assert.equal(
      stub.counts.sessions,
      2,
      'should retry the single spawn once after the transient reset',
    );
    assert.ok(
      stub.counts.health >= 2,
      'should re-probe /health after the connection error before deciding',
    );
  } finally {
    globalThis.fetch = original;
  }
  // Sanity: the stub targeted the real terminal-server base URL.
  assert.ok(BASE.startsWith('http://127.0.0.1:'));
});

test('a connection error DOES respawn when /health reports the server dead', async () => {
  const original = globalThis.fetch;
  // Health-probe outcomes, in call order, for the dead-server path:
  //   1. ensureTerminalServer() liveness probe            -> ok   (was alive)
  //   2. proxyCreateSession re-probe after the reset      -> dead (⇒ respawn)
  //   3. shutdownStale() death-confirmation poll          -> dead (old one gone)
  //   4. respawn -> ensureTerminalServer() liveness probe -> ok   (fresh one up)
  // The #4 'ok' lets ensureTerminalServer skip the real subprocess spawn.
  const stub = makeFetchStub(['ok', 'dead', 'dead', 'ok']);
  globalThis.fetch = stub.fetch;
  try {
    const result = await proxyCreateSession({ initialCommand: 'bash' });
    assert.deepEqual(result, { id: 'sess_retry' });
    assert.equal(
      stub.counts.shutdown,
      1,
      'a genuinely dead server SHOULD be shut down and respawned',
    );
    assert.equal(stub.counts.sessions, 2, 'should retry the spawn after respawn');
  } finally {
    globalThis.fetch = original;
  }
});
