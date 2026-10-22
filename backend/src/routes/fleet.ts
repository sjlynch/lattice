// Fleet routes (../fleet.ts): the cross-project snapshot + activity feed,
// "prompt a project" agent launches, and terminal screen / input / wait for
// ANY project's pty.
//
// The browser Fleet view (a human) may always use them. A non-browser caller
// — an agent's MCP tool or curl — may only read the snapshot unless the
// `fleetAgentControl` global setting is on. "Browser" = the request carries
// `Origin` or `Sec-Fetch-Site` (the global Origin check already refuses
// foreign origins). This is a guardrail for well-behaved agents, not an
// authentication boundary: the local API has none, and any process running
// as the user can already reach every pty.

import { Router, type Request, type Response } from 'express';
import {
  FleetLaunchError,
  isFleetAgentControlOn,
  launchFleetAgentNow,
  parseFleetLaunch,
  readFleetSnapshot,
  readTerminalScreen,
  sendTerminalInput,
  TerminalControlError,
  waitTerminalQuiet,
} from '../fleet.js';
import { forwardedPeerScope, scopeAllows, type PeerScope } from '../peers.js';
import { isBrowserRequest } from './requestOrigin.js';

// The scope a gateway-forwarded request needs here: launching an agent is
// `operate`, anything with a terminal is `terminals` (peers/gateway.ts).
const forwardedScope = (req: Request) => forwardedPeerScope((h) => req.get(h));

// True when the caller may control terminals; else answers 403 and returns false.
// A paired PC whose grant covers `need` was explicitly allowed by the user.
async function requireControl(req: Request, res: Response, need: PeerScope = 'terminals'): Promise<boolean> {
  const peer = forwardedScope(req);
  if (peer) {
    if (scopeAllows(peer, need)) return true;
    res.status(403).json({ code: 'peer-scope', error: `this PC was granted ${peer}; this needs ${need}` });
    return false;
  }
  if (isBrowserRequest(req) || (await isFleetAgentControlOn())) return true;
  res.status(403).json({
    code: 'fleet-agent-control-off',
    error:
      'Agents may not open or drive terminals: the user has not enabled it (Fleet panel → ' +
      '"Let agents open and drive terminals in any project", or global setting fleetAgentControl).',
  });
  return false;
}

function terminalError(res: Response, err: unknown): void {
  if (err instanceof TerminalControlError) {
    res.status(err.code === 'not-found' ? 404 : 503).json({ code: err.code, error: err.message });
    return;
  }
  throw err;
}

export function buildFleetRouter(): Router {
  const r = Router();

  r.get('/api/fleet', async (req, res) => {
    const since = Number(req.query.since);
    // A snapshot served to another PC never includes ITS paired PCs (two PCs
    // paired both ways would otherwise ask each other forever).
    const machines = !forwardedScope(req) && req.query.machines !== '0';
    res.json(await readFleetSnapshot(Number.isFinite(since) && since > 0 ? since : 0, { machines, host: req.query.host !== '0' }));
  });

  r.post('/api/fleet/agents', async (req, res) => {
    if (!(await requireControl(req, res, 'operate'))) return;
    // A human at this UI launches a plain user tab; an agent — or anything
    // arriving from another PC — launches a scoped one (no fleet tools).
    const parsed = parseFleetLaunch(req.body, isBrowserRequest(req) && !forwardedScope(req) ? 'user' : 'agent');
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    try {
      res.json(await launchFleetAgentNow(parsed));
    } catch (err) {
      if (err instanceof FleetLaunchError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

  r.get('/api/terminals/:id/screen', async (req, res) => {
    if (!(await requireControl(req, res))) return;
    const lines = Number(req.query.lines);
    try {
      res.json(await readTerminalScreen(req.params.id, { lines: Number.isFinite(lines) && lines > 0 ? lines : 200 }));
    } catch (err) {
      terminalError(res, err);
    }
  });

  r.post('/api/terminals/:id/input', async (req, res) => {
    if (!(await requireControl(req, res))) return;
    const body = (req.body ?? {}) as { text?: unknown; submit?: unknown; paste?: unknown };
    if (typeof body.text !== 'string') return res.status(400).json({ error: 'text must be a string' });
    if (body.text.length > 100_000) return res.status(400).json({ error: 'text is longer than 100000 characters' });
    try {
      await sendTerminalInput(req.params.id, body.text, {
        submit: body.submit === true,
        ...(typeof body.paste === 'boolean' ? { paste: body.paste } : {}),
      });
      res.json({ ok: true });
    } catch (err) {
      terminalError(res, err);
    }
  });

  r.post('/api/terminals/:id/wait-idle', async (req, res) => {
    if (!(await requireControl(req, res))) return;
    const body = (req.body ?? {}) as { quietMs?: unknown; timeoutMs?: unknown };
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    try {
      res.json(await waitTerminalQuiet(req.params.id, { quietMs: n(body.quietMs), timeoutMs: n(body.timeoutMs) }));
    } catch (err) {
      terminalError(res, err);
    }
  });

  return r;
}
