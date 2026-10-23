// LAN discovery: find other PCs running Lattice without typing addresses.
//
// A Lattice whose gateway is on also answers a UDP probe on DISCOVERY_PORT
// with only what pairing needs — the PC's name, its gateway port and LAN
// addresses — never a key, a project or anything else; seeing a PC grants
// nothing (pairing still takes an invite created on that PC). Any PC can
// probe: one broadcast per IPv4 interface plus 255.255.255.255, answers
// collected for a moment. Replies are rate-limited and only to well-formed
// probes, so the responder can't be used to amplify traffic.

import dgram from 'node:dgram';
import os from 'node:os';

export const DISCOVERY_PORT = 5187;
const PROBE = JSON.stringify({ lattice: 'discover', v: 1 });
const REPLIES_PER_SEC = 10;

export type DiscoveredPc = {
  name: string;
  // The address the answer came from.
  host: string;
  gatewayPort: number;
  addresses: string[];
};

type Answer = { lattice: 'here'; v: 1; name: string; gatewayPort: number; addresses: string[] };

function parseAnswer(msg: Buffer): Answer | null {
  if (msg.length > 2048) return null;
  try {
    const a = JSON.parse(msg.toString('utf8')) as Partial<Answer>;
    if (a.lattice !== 'here' || a.v !== 1 || typeof a.name !== 'string' || !Number.isInteger(a.gatewayPort)) return null;
    const addresses = Array.isArray(a.addresses) ? a.addresses.filter((x): x is string => typeof x === 'string' && /^[0-9.]{7,15}$/.test(x)).slice(0, 8) : [];
    return { lattice: 'here', v: 1, name: a.name.slice(0, 64), gatewayPort: a.gatewayPort as number, addresses };
  } catch {
    return null;
  }
}

export type DiscoveryResponder = { close: () => Promise<void>; port: () => number };

// Answer probes while the gateway listens. `info` is read per probe, so a
// port change applies at once.
export function startDiscoveryResponder(
  info: () => { gatewayPort: number; addresses: string[] },
  opts: { host?: string; port?: number; now?: () => number } = {},
): Promise<DiscoveryResponder> {
  const now = opts.now ?? Date.now;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let tokens = REPLIES_PER_SEC;
  let at = now();
  socket.on('message', (msg, rinfo) => {
    if (msg.length > 256 || msg.toString('utf8') !== PROBE) return;
    const t = now();
    tokens = Math.min(REPLIES_PER_SEC, tokens + ((t - at) / 1000) * REPLIES_PER_SEC);
    at = t;
    if (tokens < 1) return;
    tokens -= 1;
    const { gatewayPort, addresses } = info();
    const answer: Answer = { lattice: 'here', v: 1, name: os.hostname(), gatewayPort, addresses };
    socket.send(JSON.stringify(answer), rinfo.port, rinfo.address);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', (err) => { socket.close(); reject(err); });
    socket.bind(opts.port ?? DISCOVERY_PORT, opts.host ?? '0.0.0.0', () => {
      socket.removeAllListeners('error');
      socket.on('error', () => { /* a bad datagram must not take the backend down */ });
      resolve({ close: () => new Promise<void>((r) => socket.close(() => r())), port: () => socket.address().port });
    });
  });
}

// IPv4 broadcast address of each LAN interface (address | ~netmask).
export function broadcastAddresses(nets = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family !== 'IPv4' || n.internal || !n.netmask) continue;
      const a = n.address.split('.').map(Number);
      const m = n.netmask.split('.').map(Number);
      if (a.length !== 4 || m.length !== 4) continue;
      out.add(a.map((x, i) => (x | (~m[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

// Probe the LAN and collect answers for `waitMs`. `targets` overrides where
// probes go (tests send to loopback).
export function discoverPcs(opts: { waitMs?: number; port?: number; targets?: string[] } = {}): Promise<DiscoveredPc[]> {
  const port = opts.port ?? DISCOVERY_PORT;
  const targets = opts.targets ?? [...broadcastAddresses(), '255.255.255.255'];
  const socket = dgram.createSocket('udp4');
  const found = new Map<string, DiscoveredPc>();
  socket.on('message', (msg, rinfo) => {
    const a = parseAnswer(msg);
    if (!a) return;
    found.set(`${rinfo.address}:${a.gatewayPort}`, { name: a.name, host: rinfo.address, gatewayPort: a.gatewayPort, addresses: a.addresses });
  });
  return new Promise((resolve) => {
    let bound = false;
    // Unreachable interfaces are routine once bound; a failed bind means no
    // answers at all, never a promise that hangs.
    socket.on('error', () => { if (!bound) { socket.close(); resolve([]); } });
    socket.bind(0, () => {
      bound = true;
      socket.setBroadcast(true);
      for (const t of targets) socket.send(PROBE, port, t, () => { /* best effort */ });
      setTimeout(() => {
        socket.close();
        resolve([...found.values()].sort((x, y) => x.name.localeCompare(y.name)));
      }, opts.waitMs ?? 1500);
    });
  });
}
