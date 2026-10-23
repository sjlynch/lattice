// The peer gateway: the ONE Lattice listener on the network, for other PCs
// you paired. Off unless the user switches it on.
//
// Transport: TLS 1.2 with ECDHE-PSK ciphers only — each paired PC holds a
// random 256-bit key, which authenticates both ends and (with ECDHE) gives
// forward secrecy; no certificates to make or trust. A handshake with an
// unknown identity or the wrong key fails before any HTTP is read.
//
// Each request is checked against the grant's scope (a fixed allowlist of
// method + path; settings, pairing, deletes and raw terminal creation are
// never reachable), must not carry an Origin header (browsers can't speak PSK;
// refusing Origin rules out anything browser-shaped), is rate- and
// size-limited, forwarded to this backend on loopback, and appended to the
// audit log. Revoking a grant also closes its live connections.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

import { latticeHomeDir } from '../latticeHome.js';
import type { PeerGrant } from './store.js';
import type { PeerScope } from './types.js';

export const PEER_CIPHERS = 'ECDHE-PSK-CHACHA20-POLY1305:ECDHE-PSK-AES256-CBC-SHA384';
export const PEER_TLS = { ciphers: PEER_CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' } as const;
const MAX_BODY_BYTES = 1024 * 1024;
const RATE_PER_SEC = 20;
const RATE_BURST = 60;
const MAX_CONNECTIONS = 64;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

// Headers the gateway adds on the loopback hop so this backend's routes can
// tell a gateway-forwarded request (and its scope) from a local one. The token
// is minted per process and never leaves it.
export const GATEWAY_TOKEN_HEADER = 'x-lattice-gateway';
export const PEER_NAME_HEADER = 'x-lattice-peer';
export const PEER_SCOPE_HEADER = 'x-lattice-peer-scope';
export const GATEWAY_TOKEN = crypto.randomBytes(24).toString('hex');

const LEVEL: Record<PeerScope, number> = { read: 1, operate: 2, terminals: 3 };
export const scopeAllows = (granted: PeerScope, need: PeerScope) => LEVEL[granted] >= LEVEL[need];

// [method, path pattern, minimum scope]. Paths are matched without the query.
const ROUTES: Array<[string, RegExp, PeerScope]> = [
  ['GET', /^\/api\/health$/, 'read'],
  ['GET', /^\/api\/fleet$/, 'read'],
  ['GET', /^\/api\/projects$/, 'read'],
  ['GET', /^\/api\/plan-usage$/, 'read'],
  ['GET', /^\/api\/tasks(\/summary|\/search|\/[A-Za-z0-9_-]+)?$/, 'read'],
  ['GET', /^\/api\/workflows(\/[A-Za-z0-9_-]+)?$/, 'read'],
  ['GET', /^\/api\/workflow-runs\/(active|[A-Za-z0-9_-]+)$/, 'read'],
  ['GET', /^\/api\/merge-runs\/(active|[A-Za-z0-9_-]+)$/, 'read'],
  ['POST', /^\/api\/tasks(\/batch|\/transition)?$/, 'operate'],
  ['PATCH', /^\/api\/tasks\/[A-Za-z0-9_-]+$/, 'operate'],
  ['POST', /^\/api\/tasks\/[A-Za-z0-9_-]+\/(run|resume|append-summary)$/, 'operate'],
  ['POST', /^\/api\/workflows\/[A-Za-z0-9_-]+\/run$/, 'operate'],
  ['POST', /^\/api\/workflow-runs\/[A-Za-z0-9_-]+\/cancel$/, 'operate'],
  ['POST', /^\/api\/merge-runs(\/[A-Za-z0-9_-]+\/cancel)?$/, 'operate'],
  ['POST', /^\/api\/fleet\/agents$/, 'operate'],
  ['GET', /^\/api\/terminals\/[A-Za-z0-9_.-]+\/screen$/, 'terminals'],
  ['POST', /^\/api\/terminals\/[A-Za-z0-9_.-]+\/(input|wait-idle)$/, 'terminals'],
];

// The scope a request needs, or null when no scope may make it.
export function requiredScope(method: string, pathname: string): PeerScope | null {
  for (const [m, re, scope] of ROUTES) if (m === method && re.test(pathname)) return scope;
  return null;
}

export type GatewayDeps = {
  grants: () => PeerGrant[];
  // This PC's known project paths. A forwarded `project` must be one of them,
  // matched as a string BEFORE anything touches the filesystem: resolving an
  // unknown one (a `\\host\share` path) would open an SMB connection that
  // hands the attacker the user's NTLM credentials, and blocks the backend.
  knownProjects?: () => Promise<string[]>;
  // The local backend to forward to.
  backendPort: number;
  auditFile?: string;
  now?: () => number;
  onSeen?: (identity: string, at: number) => void;
};

export type PeerGateway = {
  close: () => Promise<void>;
  // Close every live connection of `identity` (revocation).
  disconnect: (identity: string) => void;
  port: () => number;
};

type Bucket = { tokens: number; at: number };

export function startPeerGateway(port: number, host: string, deps: GatewayDeps): Promise<PeerGateway> {
  const now = deps.now ?? Date.now;
  const auditFile = deps.auditFile ?? path.join(latticeHomeDir(), 'logs', 'peer-gateway.jsonl');
  const identityOf = new WeakMap<TLSSocket, string>();
  const socketsBy = new Map<string, Set<TLSSocket>>();
  const buckets = new Map<string, Bucket>();

  const audit = (row: Record<string, unknown>) => {
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      const size = fs.existsSync(auditFile) ? fs.statSync(auditFile).size : 0;
      if (size > AUDIT_MAX_BYTES) fs.renameSync(auditFile, `${auditFile}.1`);
      fs.appendFileSync(auditFile, `${JSON.stringify(row)}\n`);
    } catch { /* auditing must never take the gateway down */ }
  };
  const allow = (identity: string) => {
    const t = now();
    const b = buckets.get(identity) ?? { tokens: RATE_BURST, at: t };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((t - b.at) / 1000) * RATE_PER_SEC);
    b.at = t;
    buckets.set(identity, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  const server = https.createServer({
    ...PEER_TLS,
    pskIdentityHint: 'lattice',
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    pskCallback: (socket: TLSSocket, identity: string) => {
      const grant = deps.grants().find((g) => g.identity === identity);
      if (!grant) return null;
      identityOf.set(socket, identity);
      const set = socketsBy.get(identity) ?? new Set();
      set.add(socket);
      socketsBy.set(identity, set);
      socket.once('close', () => set.delete(socket));
      return Buffer.from(grant.key, 'base64url');
    },
  } as https.ServerOptions, (req, res) => {
    const t0 = now();
    const identity = identityOf.get(req.socket as TLSSocket);
    const grant = identity ? deps.grants().find((g) => g.identity === identity) : undefined;
    const url = new URL(req.url ?? '/', 'https://peer');
    const done = (status: number, body?: unknown) => {
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body ?? {}));
      }
      audit({ at: t0, identity, name: grant?.name, method: req.method, path: url.pathname, status, ms: now() - t0 });
    };
    if (!grant) return done(401, { error: 'unknown peer' });
    deps.onSeen?.(grant.identity, t0);
    if (req.headers.origin) return done(403, { error: 'browser requests are not accepted' });
    if (!allow(grant.identity)) return done(429, { error: 'rate limited' });
    const need = requiredScope(req.method ?? 'GET', url.pathname);
    if (!need) return done(404, { error: 'not available to peers' });
    if (!scopeAllows(grant.scope, need)) return done(403, { error: `needs the ${need} scope; this PC was granted ${grant.scope}` });

    const type = String(req.headers['content-type'] ?? '');
    if (req.method !== 'GET' && req.headers['content-length'] !== '0' && type && !/^application\/json\b/i.test(type)) {
      return done(415, { error: 'peers send JSON bodies only' });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { done(413, { error: 'body too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => void (async () => {
      if (res.headersSent) return;
      const body = Buffer.concat(chunks);
      const unknown = await unknownProject(url, body, deps.knownProjects);
      if (unknown !== null) return done(403, { error: `not a project on this PC: ${unknown.slice(0, 200)}` });
      if (res.headersSent) return;
      const fwd = http.request({
        host: '127.0.0.1',
        port: deps.backendPort,
        method: req.method,
        path: url.pathname + url.search,
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          [GATEWAY_TOKEN_HEADER]: GATEWAY_TOKEN,
          [PEER_NAME_HEADER]: encodeURIComponent(grant.name),
          [PEER_SCOPE_HEADER]: grant.scope,
        },
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, { 'content-type': up.headers['content-type'] ?? 'application/json' });
        up.pipe(res);
        up.on('end', () => audit({ at: t0, identity, name: grant.name, method: req.method, path: url.pathname, status: up.statusCode, ms: now() - t0 }));
      });
      fwd.on('error', (err) => done(502, { error: `this PC's Lattice backend is unreachable: ${err.message}` }));
      fwd.end(body);
    })());
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  // Bound what a LAN host without a key can hold open: sockets and the time
  // a handshake may take.
  server.maxConnections = MAX_CONNECTIONS;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      server.on('error', () => { /* per-connection errors are routine */ });
      server.on('tlsClientError', () => { /* failed handshakes (wrong key) are routine */ });
      resolve({
        close: () => new Promise<void>((r) => { for (const set of socketsBy.values()) for (const s of set) s.destroy(); server.close(() => r()); }),
        disconnect: (identity) => { for (const s of socketsBy.get(identity) ?? []) s.destroy(); socketsBy.delete(identity); },
        port: () => (server.address() as { port: number }).port,
      });
    });
  });
}

// The first `project` (query or JSON body) that is not one of this PC's known
// projects — string comparison only, never a filesystem call — or null.
export async function unknownProject(url: URL, body: Buffer, known: (() => Promise<string[]>) | undefined): Promise<string | null> {
  const candidates = url.searchParams.getAll('project');
  if (body.length) {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { project?: unknown };
      if (parsed && typeof parsed === 'object' && 'project' in parsed) candidates.push(String(parsed.project));
    } catch { /* not JSON: the backend will refuse it */ }
  }
  if (!candidates.length) return null;
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const knownSet = new Set((known ? await known().catch(() => [] as string[]) : []).map(norm));
  for (const c of candidates) {
    if (/^[\\/]{2}/.test(c.trim()) || !knownSet.has(norm(c))) return c;
  }
  return null;
}

// The scope a request was forwarded with, or null when it did not come through
// this process's gateway (the header token is what makes it unforgeable).
export function forwardedPeerScope(header: (name: string) => string | undefined): PeerScope | null {
  if (header(GATEWAY_TOKEN_HEADER) !== GATEWAY_TOKEN) return null;
  const s = header(PEER_SCOPE_HEADER);
  return s === 'read' || s === 'operate' || s === 'terminals' ? s : null;
}
