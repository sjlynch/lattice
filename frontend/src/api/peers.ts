// Peers: pair other PCs running Lattice so Fleet can see and drive them.
// Backend: backend/src/peers.ts, routes/peers.ts. Every write here is
// browser-only on the backend (agents can't pair or open the gateway).

import { asJson, deleteJson, postJson } from './http';
import type { PeerInvite, PeerScope, PeersView } from './types';

// A Lattice PC found on the LAN (backend/src/peers.ts LanPc).
export type LanPc = { name: string; host: string; gatewayPort: number; addresses: string[]; paired?: string; self?: boolean };

export async function discoverLanPcs(): Promise<LanPc[]> {
  return (await asJson<{ pcs: LanPc[] }>(await fetch('/api/peers/discover'))).pcs;
}

export async function fetchPeers(): Promise<PeersView> {
  return asJson<PeersView>(await fetch('/api/peers'));
}

export function setPeerGateway(enabled: boolean, port?: number): Promise<PeersView> {
  return postJson<PeersView>('/api/peers/gateway', port === undefined ? { enabled } : { enabled, port });
}

export function createPeerInvite(name: string, scope: PeerScope, host?: string): Promise<PeerInvite> {
  return postJson<PeerInvite>('/api/peers/invites', host ? { name, scope, host } : { name, scope });
}

export function revokePeerGrant(identity: string): Promise<{ revoked: boolean }> {
  return deleteJson<{ revoked: boolean }>(`/api/peers/grants/${encodeURIComponent(identity)}`);
}

export function addPeerRemote(name: string, connection: string): Promise<PeersView> {
  return postJson<PeersView>('/api/peers/remotes', { name, connection });
}

export function removePeerRemote(name: string): Promise<{ removed: boolean }> {
  return deleteJson<{ removed: boolean }>(`/api/peers/remotes/${encodeURIComponent(name)}`);
}

// An `/api/...` path on a paired PC, through this backend's proxy.
export function onMachine(machine: string | undefined, apiPath: string): string {
  return machine ? `/api/peer/${encodeURIComponent(machine)}${apiPath}` : apiPath;
}
