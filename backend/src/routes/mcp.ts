// MCP control-plane endpoints. The catalog of servers (built-ins + custom) and
// per-project enables flow through the existing global-settings / user-settings
// routes; THIS router owns the pieces that must stay off those paths:
//   - secrets: raw values never cross backend → browser (redacted/hints only)
//   - ambient env presence (booleans)
//   - one-shot key validation
//   - "import from existing tools" scan + apply
//
// SECURITY: `GET /api/mcp-secrets` returns booleans + last-4 hints, never the
// key; `PATCH` accepts a new value but never echoes it back; the import scan is
// redacted. The only place a raw key leaves Lattice is into an ephemeral
// worktree's `~/.claude.json` at spawn — inherent to stdio MCP config.

import { Router } from 'express';
import { mergedCatalog } from '../mcp/registry.js';
import {
  readMcpSecrets,
  redactSecrets,
  secretHints,
  setMcpSecret,
} from '../mcp/secrets.js';
import { validateMcpServer } from '../mcp/validators.js';
import { applyImport, scanImportableServers } from '../mcp/importConfigs.js';
import { canonicalProjectPath } from '../projectPath.js';
import { readProjectParam } from './projectParam.js';

export function buildMcpRouter(): Router {
  const r = Router();

  // The merged catalog the MCP tab renders (built-ins + per-id overrides +
  // custom servers). Holds NO secret values — those live in the secrets file.
  r.get('/api/mcp-catalog', async (_req, res) => {
    res.json({ servers: await mergedCatalog() });
  });

  // Redacted secret presence + last-4 hints, for the masked field's "key set"
  // state. Never the value.
  r.get('/api/mcp-secrets', async (_req, res) => {
    const secrets = await readMcpSecrets();
    res.json({ redacted: redactSecrets(secrets), hints: secretHints(secrets) });
  });

  // Set or clear one secret. `value: null | ''` clears it. Returns redacted.
  r.patch('/api/mcp-secrets', async (req, res) => {
    const body = (req.body || {}) as {
      serverId?: unknown;
      envVar?: unknown;
      value?: unknown;
    };
    if (typeof body.serverId !== 'string' || !body.serverId) {
      return res.status(400).json({ error: 'serverId required' });
    }
    if (typeof body.envVar !== 'string' || !body.envVar) {
      return res.status(400).json({ error: 'envVar required' });
    }
    const value =
      body.value === null || body.value === undefined
        ? null
        : typeof body.value === 'string'
          ? body.value
          : null;
    const redacted = await setMcpSecret(body.serverId, body.envVar, value);
    res.json({ redacted });
  });

  // Ambient detection: which required-secret env vars are already present in the
  // backend's process environment (booleans only). The resolver omits `env` for
  // a server whose key isn't stored, so a detected ambient var flows through.
  r.get('/api/mcp-env-presence', async (_req, res) => {
    const catalog = await mergedCatalog();
    const presence: Record<string, Record<string, boolean>> = {};
    for (const entry of catalog) {
      const vars = new Set(entry.secretEnvVars ?? []);
      if (entry.requiresSecret) vars.add(entry.requiresSecret.envVar);
      if (vars.size === 0) continue;
      presence[entry.id] = {};
      for (const v of vars) {
        presence[entry.id][v] = typeof process.env[v] === 'string' && process.env[v] !== '';
      }
    }
    res.json({ presence });
  });

  // One-shot "is my key working?" probe (v1: Brave only).
  r.post('/api/mcp/validate', async (req, res) => {
    const body = (req.body || {}) as { serverId?: unknown };
    if (typeof body.serverId !== 'string' || !body.serverId) {
      return res.status(400).json({ error: 'serverId required' });
    }
    res.json(await validateMcpServer(body.serverId));
  });

  // Scan other tools' MCP configs (Claude Code / Cursor / Codex / VS Code /
  // Windsurf). Secrets redacted to presence booleans.
  r.get('/api/mcp-import/scan', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query', optional: true });
    if (project === null) return;
    const projectPath = project ? canonicalProjectPath(project) : undefined;
    res.json(await scanImportableServers(projectPath));
  });

  // Apply selected imports: add custom server defs to the global catalog and
  // store any literal keys in the secrets file.
  r.post('/api/mcp-import', async (req, res) => {
    const body = (req.body || {}) as { ids?: unknown; project?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string')
      : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids required' });
    const project = readProjectParam(req, res, { source: 'body', optional: true });
    if (project === null) return;
    const projectPath = project ? canonicalProjectPath(project) : undefined;
    res.json(await applyImport(ids, projectPath));
  });

  return r;
}
