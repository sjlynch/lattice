// The peer gateway — the one Lattice listener on the network. Pins its
// security properties end to end over real TLS-PSK sockets, with a fake local
// backend behind it:
//   - only a known identity with the right key completes a handshake;
//   - a pooled socket is never reused across credentials (the client opens a
//     connection per request — a kept-alive socket once let a wrong key ride
//     an authenticated connection);
//   - each route needs a scope; settings / pairing / deletes are unreachable;
//   - a request carrying Origin is refused;
//   - forwarded requests carry the per-process gateway token + scope, which
//     `forwardedPeerScope` accepts only from this process;
//   - revoking a grant closes its connections and refuses the next handshake.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { peerRequest } from '../peers/client.js';
import { formatPeerConnection, lanAddresses, parsePeerConnection } from '../peers/connection.js';
import { forwardedPeerScope, GATEWAY_TOKEN, GATEWAY_TOKEN_HEADER, requiredScope, startPeerGateway } from '../peers/gateway.js';
import { newIdentity, newKey, type PeerGrant } from '../peers/store.js';

async function fakeBackend() {
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function grant(scope: PeerGrant['scope'], name = 'laptop'): PeerGrant & { rawKey: Buffer } {
  const rawKey = newKey();
  return { identity: newIdentity(), name, scope, key: rawKey.toString('base64url'), createdAt: 1, rawKey };
}

test('connection strings round-trip and reject malformed input', () => {
  const key = newKey();
  const s = formatPeerConnection({ host: '192.168.8.192', port: 5186, identity: 'abcdef0123456789', key });
  assert.ok(s.startsWith('lattice-peer:1:192.168.8.192:5186:abcdef0123456789:'));
  const p = parsePeerConnection(` ${s} `);
  assert.ok(!('error' in p));
  assert.ok(p.key.equals(key));
  for (const bad of ['', 'http://x', 'lattice-peer:1:host:0:abcdef0123456789:' + key.toString('base64url'), 'lattice-peer:1:h st:5186:abcdef0123456789:' + key.toString('base64url'), 'lattice-peer:1:host:5186:XYZ:' + key.toString('base64url'), 'lattice-peer:1:host:5186:abcdef0123456789:short']) {
    assert.ok('error' in parsePeerConnection(bad), bad);
  }
});

test('lanAddresses keeps external IPv4, private ranges first', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth: [{ address: '8.8.4.4', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    wifi: [{ address: '192.168.8.10', family: 'IPv4', internal: false }, { address: '169.254.1.1', family: 'IPv4', internal: false }],
  } as unknown as ReturnType<typeof os.networkInterfaces>;
  assert.deepEqual(lanAddresses(ifaces), ['192.168.8.10', '8.8.4.4']);
});

test('requiredScope: read < operate < terminals; settings, pairing and deletes are never reachable', () => {
  assert.equal(requiredScope('GET', '/api/fleet'), 'read');
  assert.equal(requiredScope('GET', '/api/tasks/summary'), 'read');
  assert.equal(requiredScope('POST', '/api/tasks/t_1/run'), 'operate');
  assert.equal(requiredScope('POST', '/api/fleet/agents'), 'operate');
  assert.equal(requiredScope('POST', '/api/terminals/tty_1/input'), 'terminals');
  for (const [m, p] of [['PATCH', '/api/settings'], ['PATCH', '/api/global-settings'], ['POST', '/api/peers/invites'], ['DELETE', '/api/tasks/t_1'], ['POST', '/api/terminals'], ['GET', '/api/peer/x/api/fleet'], ['POST', '/api/project-init']] as const) {
    assert.equal(requiredScope(m, p), null, `${m} ${p}`);
  }
});

test('gateway: PSK auth, scope, Origin refusal, forwarding headers, revocation', async (t) => {
  const backend = await fakeBackend();
  const reader = grant('read', 'reader-pc');
  const operator = grant('terminals', 'ops-pc');
  let grants: PeerGrant[] = [reader, operator];
  const audit = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-audit-')), 'audit.jsonl');
  const gw = await startPeerGateway(0, '127.0.0.1', { grants: () => grants, backendPort: backend.port, auditFile: audit });
  t.after(async () => { await gw.close(); await backend.close(); fs.rmSync(path.dirname(audit), { recursive: true, force: true }); });
  const as = (g: PeerGrant, key = g.key) => ({ host: '127.0.0.1', port: gw.port(), identity: g.identity, key });

  // Right key: forwarded, with the gateway token, scope and peer name.
  const ok = await peerRequest(as(reader), 'GET', '/api/fleet?since=3');
  assert.equal(ok.status, 200);
  const fwd = backend.seen.at(-1)!;
  assert.equal(fwd.url, '/api/fleet?since=3');
  assert.equal(fwd.headers[GATEWAY_TOKEN_HEADER], GATEWAY_TOKEN);
  assert.equal(fwd.headers['x-lattice-peer-scope'], 'read');
  assert.equal(fwd.headers['x-lattice-peer'], 'reader-pc');
  assert.equal(forwardedPeerScope((h) => fwd.headers[h] as string | undefined), 'read');
  assert.equal(forwardedPeerScope((h) => (h === GATEWAY_TOKEN_HEADER ? 'forged' : 'terminals')), null);

  // Wrong key, then the right one again — each request is its own handshake,
  // so the failure is real and the success after it is too.
  await assert.rejects(peerRequest(as(reader, newKey().toString('base64url')), 'GET', '/api/fleet'));
  assert.equal((await peerRequest(as(reader), 'GET', '/api/fleet')).status, 200);
  // Unknown identity.
  await assert.rejects(peerRequest({ ...as(reader), identity: newIdentity() }, 'GET', '/api/fleet'));

  // Scope: read can't run tasks or touch terminals; terminals can.
  assert.equal((await peerRequest(as(reader), 'POST', '/api/tasks/t_1/run', '{}')).status, 403);
  assert.equal((await peerRequest(as(reader), 'POST', '/api/terminals/tty_1/input', '{"text":"x"}')).status, 403);
  const input = await peerRequest(as(operator), 'POST', '/api/terminals/tty_1/input', '{"text":"x","submit":true}');
  assert.equal(input.status, 200);
  assert.equal(backend.seen.at(-1)!.body, '{"text":"x","submit":true}');
  // Never-reachable routes, for any scope.
  assert.equal((await peerRequest(as(operator), 'PATCH', '/api/settings', '{}')).status, 404);
  assert.equal((await peerRequest(as(operator), 'POST', '/api/peers/invites', '{}')).status, 404);

  // A browser-shaped request (Origin) is refused even with a valid key.
  const withOrigin = await new Promise<number>((resolve, reject) => {
    import('node:https').then(({ default: https }) => {
      const req = https.request({
        host: '127.0.0.1', port: gw.port(), path: '/api/fleet', method: 'GET', agent: false,
        ciphers: 'ECDHE-PSK-CHACHA20-POLY1305', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
        pskCallback: () => ({ psk: reader.rawKey, identity: reader.identity }), checkServerIdentity: () => undefined,
        headers: { origin: 'http://evil.example' },
      } as never, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    }, reject);
  });
  assert.equal(withOrigin, 403);

  // Every request is audited with the peer's name.
  const rows = fs.readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.name === 'ops-pc' && r.path === '/api/terminals/tty_1/input' && r.status === 200));

  // Revoke: the next handshake fails.
  grants = [operator];
  gw.disconnect(reader.identity);
  await assert.rejects(peerRequest(as(reader), 'GET', '/api/fleet'));
  assert.equal((await peerRequest(as(operator), 'GET', '/api/fleet')).status, 200);
});
