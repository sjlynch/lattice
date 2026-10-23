// `~/.lattice/peers.json`: the gateway switch, the PCs allowed in (grants) and
// the PCs this one connects to (remotes), with their pre-shared keys. Keys
// leave this module only toward the TLS layer — every view strips them.
//
// Read-modify-write under one lock; an unreadable / corrupt file is never
// replaced by defaults (a PATCH would otherwise silently drop every pairing).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '../fsAtomic.js';
import { latticeHomeDir } from '../latticeHome.js';
import { runExclusive } from '../serializeWrites.js';
import type { PeerGrantView, PeerRemoteView, PeerScope } from './types.js';

export const DEFAULT_GATEWAY_PORT = 5186;

export type PeerGrant = PeerGrantView & { key: string };
export type PeerRemote = PeerRemoteView & { identity: string; key: string };
export type PeersFile = {
  gateway: { enabled: boolean; port: number };
  grants: PeerGrant[];
  remotes: PeerRemote[];
};

const EMPTY: PeersFile = { gateway: { enabled: false, port: DEFAULT_GATEWAY_PORT }, grants: [], remotes: [] };
const SCOPES: readonly PeerScope[] = ['read', 'operate', 'terminals'];

export const peersFile = () => path.join(latticeHomeDir(), 'peers.json');
export const isPeerScope = (v: unknown): v is PeerScope => SCOPES.includes(v as PeerScope);
// A name shown in the UI and audit log: printable, ≤ 40 chars.
export const cleanPeerName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return s || null;
};

function normalize(raw: unknown): PeersFile {
  const r = (raw ?? {}) as Partial<PeersFile>;
  const g = (r.gateway ?? {}) as Partial<PeersFile['gateway']>;
  const port = Number.isInteger(g.port) && (g.port as number) > 0 && (g.port as number) < 65536 ? (g.port as number) : DEFAULT_GATEWAY_PORT;
  const grants = (Array.isArray(r.grants) ? r.grants : []).filter((x): x is PeerGrant =>
    !!x && /^[0-9a-f]{16}$/.test(x.identity) && typeof x.key === 'string' && Buffer.from(x.key, 'base64url').length === 32 && isPeerScope(x.scope) && !!cleanPeerName(x.name));
  const remotes = (Array.isArray(r.remotes) ? r.remotes : []).filter((x): x is PeerRemote =>
    !!x && !!cleanPeerName(x.name) && typeof x.host === 'string' && Number.isInteger(x.port) && /^[0-9a-f]{16}$/.test(x.identity) && typeof x.key === 'string' && Buffer.from(x.key, 'base64url').length === 32);
  return { gateway: { enabled: g.enabled === true, port }, grants, remotes };
}

export async function readPeers(file = peersFile()): Promise<PeersFile> {
  try {
    return normalize(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
    throw err;
  }
}

export function updatePeers<T>(fn: (p: PeersFile) => T, file = peersFile()): Promise<{ peers: PeersFile; result: T }> {
  return runExclusive(`peers:${file}`, async () => {
    const peers = await readPeers(file);
    const result = fn(peers);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, `${JSON.stringify(peers, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
    return { peers, result };
  });
}

export const newIdentity = () => crypto.randomBytes(8).toString('hex');
export const newKey = () => crypto.randomBytes(32);

export const grantView = ({ key: _k, ...g }: PeerGrant): PeerGrantView => g;
export const remoteView = ({ key: _k, identity: _i, ...r }: PeerRemote): PeerRemoteView => r;
