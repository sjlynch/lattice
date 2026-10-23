// Calling a paired PC's gateway: TLS-PSK with that remote's identity + key.
// Every request opens its own connection (`agent: false`): a pooled socket
// is authenticated once, at its handshake, so reusing it would let a request
// ride a connection made with other credentials (and a key change or removal
// would keep working until the socket idled out).

import https from 'node:https';

import { PEER_TLS } from './gateway.js';
import type { PeerRemote } from './store.js';

export type PeerResponse = { status: number; body: string; contentType: string };

export class PeerUnreachableError extends Error {}

// A paired PC's answer is bounded in time (the whole exchange, not just idle
// gaps) and size, so a slow or hostile remote can't hang a Fleet poll or
// grow this process's memory.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function peerRequest(
  remote: Pick<PeerRemote, 'host' | 'port' | 'identity' | 'key'>,
  method: string,
  pathAndQuery: string,
  body?: Buffer | string,
  timeoutMs = 60_000,
): Promise<PeerResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = https.request({
      host: remote.host,
      port: remote.port,
      method,
      path: pathAndQuery,
      agent: false,
      ...PEER_TLS,
      pskCallback: () => ({ psk: Buffer.from(remote.key, 'base64url'), identity: remote.identity }),
      // No certificate to verify: the PSK handshake authenticates the server.
      checkServerIdentity: () => undefined,
      headers: payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {},
      timeout: timeoutMs,
    } as https.RequestOptions, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8'), contentType: String(res.headers['content-type'] ?? 'application/json') }));
      res.on('error', (err) => reject(new PeerUnreachableError(err.message)));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', (err) => reject(new PeerUnreachableError(`${remote.host}:${remote.port}: ${(err as NodeJS.ErrnoException).code ?? err.message}`)));
    req.end(payload);
  });
}
