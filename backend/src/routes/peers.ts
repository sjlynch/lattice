// Peers routes (../peers.ts): pairing other PCs and calling them.
//
// Everything that changes who may reach this machine — the gateway switch,
// invites, revocation, adding / removing a paired PC — is browser-only (the
// user at the UI), never an agent. Reading the (key-free) view is open. The
// proxy `/api/peer/:name/*` is allowed to the browser, and to agents only
// with the `fleetAgentControl` global setting; the paired PC's own grant scope
// is the real limit either way.

import { Router, type Request, type Response } from 'express';

import { isFleetAgentControlOn } from '../fleet.js';
import { addRemote, callRemote, createInvite, PeersError, PeerUnreachableError, readPeersView, removeRemote, revokeGrant, setGateway } from '../peers.js';
import { isBrowserRequest } from './requestOrigin.js';

function browserOnly(req: Request, res: Response): boolean {
  if (isBrowserRequest(req)) return true;
  res.status(403).json({ code: 'peers-browser-only', error: 'Pairing and the gateway are changed only from the Lattice UI (Fleet → PCs), never by an agent.' });
  return false;
}

function peersError(res: Response, err: unknown): void {
  if (err instanceof PeersError) { res.status(err.status).json({ error: err.message }); return; }
  if (err instanceof PeerUnreachableError) { res.status(502).json({ code: 'peer-unreachable', error: err.message }); return; }
  throw err;
}

export function buildPeersRouter(): Router {
  const r = Router();

  r.get('/api/peers', async (_req, res) => {
    res.json(await readPeersView());
  });

  r.post('/api/peers/gateway', async (req, res) => {
    if (!browserOnly(req, res)) return;
    const b = (req.body ?? {}) as { enabled?: unknown; port?: unknown };
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    try {
      res.json(await setGateway(b.enabled, b.port === undefined ? undefined : Number(b.port)));
    } catch (err) {
      peersError(res, err);
    }
  });

  r.post('/api/peers/invites', async (req, res) => {
    if (!browserOnly(req, res)) return;
    const b = (req.body ?? {}) as { name?: unknown; scope?: unknown; host?: unknown };
    try {
      res.json(await createInvite(b.name, b.scope, b.host));
    } catch (err) {
      peersError(res, err);
    }
  });

  r.delete('/api/peers/grants/:identity', async (req, res) => {
    if (!browserOnly(req, res)) return;
    res.json({ revoked: await revokeGrant(req.params.identity) });
  });

  r.post('/api/peers/remotes', async (req, res) => {
    if (!browserOnly(req, res)) return;
    const b = (req.body ?? {}) as { name?: unknown; connection?: unknown };
    try {
      res.json(await addRemote(b.name, b.connection));
    } catch (err) {
      peersError(res, err);
    }
  });

  r.delete('/api/peers/remotes/:name', async (req, res) => {
    if (!browserOnly(req, res)) return;
    res.json({ removed: await removeRemote(req.params.name) });
  });

  // `/api/peer/<name>/api/...` → that PC's gateway, same method, path, query
  // and JSON body (re-serialized from the app's JSON parser).
  r.all('/api/peer/:name/*', async (req, res) => {
    if (!isBrowserRequest(req) && !(await isFleetAgentControlOn())) {
      return res.status(403).json({ code: 'fleet-agent-control-off', error: 'Agents may reach other PCs only when the user turned on agent control in the Fleet panel. Ask the user.' });
    }
    const rest = `/${String((req.params as unknown as Record<string, unknown>)['0'] ?? '')}`;
    if (!rest.startsWith('/api/')) return res.status(400).json({ error: 'only /api/ paths can be forwarded' });
    const q = req.originalUrl.indexOf('?');
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody ? Buffer.from(JSON.stringify(req.body ?? {})) : undefined;
    try {
      const up = await callRemote(req.params.name, req.method, rest + (q >= 0 ? req.originalUrl.slice(q) : ''), body, 120_000);
      // Always JSON, never sniffed: a paired PC must not be able to serve
      // HTML (and script) on this UI's origin.
      res.status(up.status).set('X-Content-Type-Options', 'nosniff').type('application/json').send(up.body);
    } catch (err) {
      peersError(res, err);
    }
  });

  return r;
}
