// Peers through the real routes and facade, pairing this process with itself
// over loopback (isolated HOME; PORT points the gateway's forwarding at a
// fake backend, never a live one). Pins: pairing and the gateway switch are
// browser-only (an agent gets 403); no response ever contains a key; a
// connection string pairs and the proxy reaches the other side's API; an
// agent needs agent control to use the proxy; revoking cuts it off.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

import { buildPeersRouter } from '../routes/peers.js';
import { setGateway } from '../peers.js';

const BROWSER = { 'sec-fetch-site': 'same-origin' };

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

test('peers routes: browser-only pairing, key-free views, proxy, agent gate, revoke', async (t) => {
  const backend = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: 'backend', url: req.url, peer: req.headers['x-lattice-peer'] }));
  });
  const prevPort = process.env.PORT;
  process.env.PORT = String(backend.port);
  const app = express();
  app.use(express.json());
  app.use(buildPeersRouter());
  const api = await listen(app);
  const base = `http://127.0.0.1:${api.port}`;
  // Ask the OS for a free port (Windows reserves random blocks of high ports).
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const gatewayPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  t.after(async () => {
    await setGateway(false).catch(() => {});
    api.server.close();
    backend.server.close();
    if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
  });
  const post = (p: string, body: unknown, headers: Record<string, string> = BROWSER) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // Agents can't switch the gateway or invite.
  const agentTry = await post('/api/peers/gateway', { enabled: true, port: gatewayPort }, {});
  assert.equal(agentTry.status, 403);
  assert.equal(((await agentTry.json()) as { code: string }).code, 'peers-browser-only');
  assert.equal((await post('/api/peers/invites', { name: 'x', scope: 'read' }, {})).status, 403);

  const on = await post('/api/peers/gateway', { enabled: true, port: gatewayPort });
  assert.equal(on.status, 200);
  assert.equal(((await on.json()) as { gateway: { listening: boolean } }).gateway.listening, true);

  const invite = (await (await post('/api/peers/invites', { name: 'me-again', scope: 'operate', host: '127.0.0.1' })).json()) as { identity: string; connection: string };
  assert.match(invite.connection, new RegExp(`^lattice-peer:1:127\\.0\\.0\\.1:${gatewayPort}:[0-9a-f]{16}:`));

  assert.equal((await post('/api/peers/remotes', { name: 'loop', connection: invite.connection })).status, 200);
  const view = await (await fetch(`${base}/api/peers`)).text();
  assert.ok(!/"key"/.test(view), 'no key in any view');
  const parsed = JSON.parse(view) as { grants: unknown[]; remotes: Array<{ name: string }> };
  assert.equal(parsed.grants.length, 1);
  assert.deepEqual(parsed.remotes.map((r) => r.name), ['loop']);

  // The proxy reaches the other side's API (through its gateway, to its backend).
  const via = await fetch(`${base}/api/peer/loop/api/fleet?since=2`, { headers: BROWSER });
  assert.equal(via.status, 200);
  assert.deepEqual(await via.json(), { from: 'backend', url: '/api/fleet?since=2', peer: 'me-again' });
  // Agents need agent control (off in this isolated HOME).
  assert.equal((await fetch(`${base}/api/peer/loop/api/fleet`)).status, 403);
  // Out of the grant's scope (operate can't reach terminals): the far side refuses.
  assert.equal((await post('/api/peer/loop/api/terminals/tty_1/input', { text: 'x' })).status, 403);

  // Revoke on the far side: the proxy now fails to connect.
  const revoke = await fetch(`${base}/api/peers/grants/${invite.identity}`, { method: 'DELETE', headers: BROWSER });
  assert.deepEqual(await revoke.json(), { revoked: true });
  assert.equal((await fetch(`${base}/api/peer/loop/api/fleet`, { headers: BROWSER })).status, 502);
});
