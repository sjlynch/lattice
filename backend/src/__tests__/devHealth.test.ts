import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { probeHealth, waitForHealth } from '../../../scripts/orchestrate/health.mjs';

// The orchestrator boots the frontend only once `/api/health` answers 200 —
// or once `HEALTH_TIMEOUT_MS` lapses. The deadline has to hold against a
// backend that never comes up (ECONNREFUSED on every poll).

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

test('waitForHealth gives up at the deadline when nothing ever listens', async () => {
  const port = await closedPort();
  const started = Date.now();
  const ok = await waitForHealth(`http://127.0.0.1:${port}/api/health`, 350);
  const elapsed = Date.now() - started;
  assert.equal(ok, false);
  assert.ok(elapsed >= 340, `returned after ${elapsed} ms, before the 350 ms deadline`);
  assert.ok(elapsed < 5000, `took ${elapsed} ms — the poll must not overshoot the deadline by more than one interval`);
});

test('waitForHealth resolves true as soon as the probe sees a 200, and probeHealth rejects non-200', async (t) => {
  let status = 503;
  const server = http.createServer((_req, res) => { res.statusCode = status; res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
  assert.equal(await probeHealth(url), false, 'a 503 is not healthy');
  setTimeout(() => { status = 200; }, 150);
  const started = Date.now();
  assert.equal(await waitForHealth(url, 10_000), true);
  assert.ok(Date.now() - started < 5000, 'returned promptly once healthy, well inside the deadline');
});
