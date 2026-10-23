// Peers: other PCs on the network running Lattice, paired so you (and agents
// you allow) can see and drive their projects from here — Fleet across
// machines. One side switches its gateway on and invites the other with a
// one-time connection string (a 256-bit pre-shared key + a scope); the other
// pastes it. See peers/CLAUDE.md for the security model.

import os from 'node:os';

import { backendPort } from './server/config.js';
import { listKnownProjects } from './tasks.js';
import { formatPeerConnection, lanAddresses, parsePeerConnection } from './peers/connection.js';
import { startPeerGateway, type PeerGateway } from './peers/gateway.js';
import { peerRequest, PeerUnreachableError, type PeerResponse } from './peers/client.js';
import { cleanPeerName, grantView, isPeerScope, newIdentity, newKey, readPeers, remoteView, updatePeers } from './peers/store.js';
import type { PeerInvite, PeerScope, PeersView } from './peers/types.js';

export { forwardedPeerScope, scopeAllows } from './peers/gateway.js';
export { PeerUnreachableError } from './peers/client.js';

let gateway: PeerGateway | null = null;
let gatewayError: string | undefined;
const lastSeen = new Map<string, number>();
// The grants the gateway's PSK callback checks: refreshed on every change,
// so a revoke or a new invite applies without a restart.
let grantsCache: Awaited<ReturnType<typeof readPeers>>['grants'] = [];

export class PeersError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) {
    super(message);
  }
}

async function applyGateway(): Promise<void> {
  const peers = await readPeers();
  const want = peers.gateway.enabled;
  if (gateway && (!want || gateway.port() !== peers.gateway.port)) {
    await gateway.close();
    gateway = null;
  }
  gatewayError = undefined;
  if (want && !gateway) {
    try {
      // LATTICE_PEER_GATEWAY_HOST: tests and e2e bind loopback (no LAN, no
      // firewall prompt); a real gateway listens on every interface.
      gateway = await startPeerGateway(peers.gateway.port, process.env.LATTICE_PEER_GATEWAY_HOST || '0.0.0.0', {
        grants: () => grantsCache,
        backendPort: backendPort(),
        knownProjects: listKnownProjects,
        onSeen: (id, at) => lastSeen.set(id, at),
      });
    } catch (err) {
      gatewayError = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `port ${peers.gateway.port} is in use`
        : (err as Error).message;
    }
  }
  grantsCache = peers.grants;
}

// Boot: start the gateway when it was left on. Never throws.
export async function startPeers(): Promise<void> {
  try { await applyGateway(); } catch (err) { gatewayError = (err as Error).message; }
}

export async function readPeersView(): Promise<PeersView> {
  const peers = await readPeers();
  return {
    gateway: { enabled: peers.gateway.enabled, port: peers.gateway.port, listening: !!gateway, addresses: lanAddresses(), ...(gatewayError ? { error: gatewayError } : {}) },
    grants: peers.grants.map((g) => ({ ...grantView(g), ...(lastSeen.has(g.identity) ? { lastSeenAt: lastSeen.get(g.identity) } : {}) })),
    remotes: peers.remotes.map(remoteView),
  };
}

export async function setGateway(enabled: boolean, port?: number): Promise<PeersView> {
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new PeersError('port must be 1024–65535', 400);
  await updatePeers((p) => { p.gateway.enabled = enabled; if (port !== undefined) p.gateway.port = port; });
  await applyGateway();
  return readPeersView();
}

export async function createInvite(nameRaw: unknown, scopeRaw: unknown, hostRaw?: unknown): Promise<PeerInvite> {
  const name = cleanPeerName(nameRaw);
  if (!name) throw new PeersError('name is required', 400);
  if (!isPeerScope(scopeRaw)) throw new PeersError('scope must be read, operate or terminals', 400);
  const identity = newIdentity();
  const key = newKey();
  const { peers } = await updatePeers((p) => {
    p.grants.push({ identity, name, scope: scopeRaw, key: key.toString('base64url'), createdAt: Date.now() });
  });
  grantsCache = peers.grants;
  const host = typeof hostRaw === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(hostRaw) ? hostRaw : (lanAddresses()[0] ?? os.hostname());
  return { identity, name, scope: scopeRaw, connection: formatPeerConnection({ host, port: peers.gateway.port, identity, key }) };
}

export async function revokeGrant(identity: string): Promise<boolean> {
  const { peers, result } = await updatePeers((p) => {
    const before = p.grants.length;
    p.grants = p.grants.filter((g) => g.identity !== identity);
    return p.grants.length !== before;
  });
  grantsCache = peers.grants;
  gateway?.disconnect(identity);
  lastSeen.delete(identity);
  return result;
}

// Pair with another PC from its connection string; checks it answers.
export async function addRemote(nameRaw: unknown, connectionRaw: unknown): Promise<PeersView> {
  const name = cleanPeerName(nameRaw);
  if (!name) throw new PeersError('name is required', 400);
  if (typeof connectionRaw !== 'string') throw new PeersError('connection is required', 400);
  const c = parsePeerConnection(connectionRaw);
  if ('error' in c) throw new PeersError(c.error, 400);
  const remote = { name, host: c.host, port: c.port, identity: c.identity, key: c.key.toString('base64url'), addedAt: Date.now() };
  let health: PeerResponse;
  try {
    health = await peerRequest(remote, 'GET', '/api/health', undefined, 8_000);
  } catch (err) {
    throw new PeersError(`could not reach ${c.host}:${c.port} — is its gateway on? (${(err as Error).message})`, 502);
  }
  if (health.status !== 200) throw new PeersError(`${c.host}:${c.port} answered ${health.status}`, 502);
  await updatePeers((p) => {
    if (p.remotes.some((r) => r.name === name)) throw new PeersError(`a PC named ${name} is already paired`, 409);
    p.remotes.push(remote);
  });
  return readPeersView();
}

export async function removeRemote(name: string): Promise<boolean> {
  return (await updatePeers((p) => {
    const before = p.remotes.length;
    p.remotes = p.remotes.filter((r) => r.name !== name);
    return p.remotes.length !== before;
  })).result;
}

// Forward one API call to a paired PC.
export async function callRemote(name: string, method: string, pathAndQuery: string, body?: Buffer, timeoutMs?: number): Promise<PeerResponse> {
  const remote = (await readPeers()).remotes.find((r) => r.name === name);
  if (!remote) throw new PeersError(`no paired PC named ${name}`, 404);
  return peerRequest(remote, method, pathAndQuery, body, timeoutMs);
}

// Every paired PC's Fleet snapshot (bounded wait, failures reported per PC).
export async function readRemoteFleets(): Promise<Array<{ name: string; ok: boolean; error?: string; snapshot?: unknown }>> {
  const remotes = (await readPeers().catch(() => null))?.remotes ?? [];
  return Promise.all(remotes.map(async (r) => {
    try {
      const res = await peerRequest(r, 'GET', '/api/fleet', undefined, 4_000);
      if (res.status !== 200) return { name: r.name, ok: false, error: `HTTP ${res.status}` };
      return { name: r.name, ok: true, snapshot: JSON.parse(res.body) as unknown };
    } catch (err) {
      return { name: r.name, ok: false, error: err instanceof PeerUnreachableError ? err.message : (err as Error).message };
    }
  }));
}

export type { PeerScope };
