// LAN discovery (peers/discovery.ts), over real UDP on loopback: a probe gets
// an answer naming only the PC, its gateway port and addresses — never a key
// or a project; anything but the exact probe gets nothing; answers are
// rate-limited so the responder can't amplify traffic; broadcast addresses
// come from each IPv4 interface's address and netmask.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import os from 'node:os';
import test from 'node:test';

import { broadcastAddresses, discoverPcs, startDiscoveryResponder } from '../peers/discovery.js';

test('a probe finds the PC with only pairing facts; junk and floods get little or nothing', async (t) => {
  const responder = await startDiscoveryResponder(() => ({ gatewayPort: 5186, addresses: ['192.168.8.10'] }), { host: '127.0.0.1', port: 0 });
  t.after(() => responder.close());

  const pcs = await discoverPcs({ targets: ['127.0.0.1'], port: responder.port(), waitMs: 300 });
  assert.deepEqual(pcs, [{ name: os.hostname(), host: '127.0.0.1', gatewayPort: 5186, addresses: ['192.168.8.10'] }]);

  // Raw socket: count replies to junk and to a burst of real probes.
  const sock = dgram.createSocket('udp4');
  const replies: string[] = [];
  sock.on('message', (m) => replies.push(m.toString('utf8')));
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  t.after(() => sock.close());
  const send = (text: string) => new Promise<void>((r) => sock.send(text, responder.port(), '127.0.0.1', () => r()));
  await send('{"lattice":"discover","v":2}');
  await send('hello');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(replies.length, 0, 'only the exact probe is answered');
  for (let i = 0; i < 40; i++) await send('{"lattice":"discover","v":1}');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(replies.length >= 1 && replies.length <= 12, `rate-limited: ${replies.length} answers to 40 probes`);
  const answer = JSON.parse(replies[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(answer).sort(), ['addresses', 'gatewayPort', 'lattice', 'name', 'v']);
});

test('broadcastAddresses: address | ~netmask per external IPv4 interface', () => {
  const nets = {
    eth: [
      { family: 'IPv4', address: '192.168.8.10', netmask: '255.255.255.0', internal: false },
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false },
    ],
    vpn: [{ family: 'IPv4', address: '10.20.30.40', netmask: '255.255.0.0', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  } as unknown as ReturnType<typeof os.networkInterfaces>;
  assert.deepEqual(broadcastAddresses(nets), ['192.168.8.255', '10.20.255.255']);
});
