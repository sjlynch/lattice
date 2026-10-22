// Fleet routes' agent gate: anyone may read GET /api/fleet, but a NON-browser
// caller (no Origin / Sec-Fetch-Site — an agent's MCP tool or curl) gets 403
// `fleet-agent-control-off` on launch / screen / input / wait while the
// `fleetAgentControl` global setting is off (its default). A browser request
// passes the gate (here it then finds no terminal server: the test preload
// points TERMINAL_PORT at a closed port → 503), and bad input is a 400.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

import { buildFleetRouter } from '../routes/fleet.js';

async function serve() {
  const app = express();
  app.use(express.json());
  app.use(buildFleetRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('fleet: snapshot open to all; control gated for agents while fleetAgentControl is off', async () => {
  const { base, close } = await serve();
  try {
    const snap = await fetch(`${base}/api/fleet`);
    assert.equal(snap.status, 200);
    const body = (await snap.json()) as { projects: unknown[]; agentControl: boolean; seq: number };
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.agentControl, false);

    for (const [method, path] of [['GET', '/api/terminals/p1/screen'], ['POST', '/api/terminals/p1/input'], ['POST', '/api/terminals/p1/wait-idle'], ['POST', '/api/fleet/agents']] as const) {
      const res = method === 'GET' ? await fetch(`${base}${path}`) : await post(`${base}${path}`, { text: 'x' });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(((await res.json()) as { code: string }).code, 'fleet-agent-control-off');
    }

    const browser = { 'sec-fetch-site': 'same-origin' };
    const input = await post(`${base}/api/terminals/p1/input`, { text: 'x' }, browser);
    assert.equal(input.status, 503, 'past the gate, no executor to reach');
    assert.equal((await post(`${base}/api/terminals/p1/input`, { text: 5 }, browser)).status, 400);
    assert.equal((await post(`${base}/api/fleet/agents`, { project: 'relative', harness: 'claude', prompt: 'x' }, browser)).status, 400);
  } finally {
    await close();
  }
});
