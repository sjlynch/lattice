// The invite string one PC hands another, and the LAN addresses to put in it.
//
//   lattice-peer:1:<host>:<port>:<identity>:<key>
//
// `host` is an IPv4 address or hostname, `identity` 16 hex chars naming the
// grant, `key` the 32-byte pre-shared key as base64url. Whoever holds the
// string can connect with the grant's scope until it is revoked — it is shown
// once and should travel like a password.

import os from 'node:os';

export const PEER_CONNECTION_PREFIX = 'lattice-peer:1:';

export type PeerConnection = { host: string; port: number; identity: string; key: Buffer };

export function formatPeerConnection(c: PeerConnection): string {
  return `${PEER_CONNECTION_PREFIX}${c.host}:${c.port}:${c.identity}:${c.key.toString('base64url')}`;
}

export function parsePeerConnection(raw: string): PeerConnection | { error: string } {
  const s = raw.trim();
  if (!s.startsWith(PEER_CONNECTION_PREFIX)) return { error: 'not a Lattice peer connection string (it starts with lattice-peer:1:)' };
  const parts = s.slice(PEER_CONNECTION_PREFIX.length).split(':');
  if (parts.length !== 4) return { error: 'malformed connection string' };
  const [host, portRaw, identity, keyRaw] = parts;
  const port = Number(portRaw);
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return { error: 'bad host in connection string' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'bad port in connection string' };
  if (!/^[0-9a-f]{16}$/.test(identity)) return { error: 'bad identity in connection string' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(keyRaw)) return { error: 'bad key in connection string' };
  const key = Buffer.from(keyRaw, 'base64url');
  if (key.length !== 32) return { error: 'bad key in connection string' };
  return { host, port, identity, key };
}

// Non-internal IPv4 addresses, private ranges first.
export function lanAddresses(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...new Set(out)].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}
