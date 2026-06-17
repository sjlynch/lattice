// Per-server "is my key actually working?" checks behind POST /api/mcp/validate.
// MCP servers start INSIDE the harness's process, so Lattice can't observe a
// runtime failure — a cheap manual probe is the only way to close the
// otherwise-invisible "did I paste the right key?" loop. v1 ships the Brave
// validator only; add a `case` per keyed server as the catalog grows.

import { readMcpSecrets } from './secrets.js';
import { builtinMcpServerById } from './catalog.js';

export type McpValidationResult = { ok: boolean; error?: string };

export async function validateMcpServer(serverId: string): Promise<McpValidationResult> {
  switch (serverId) {
    case 'brave-search':
      return validateBrave();
    default:
      return {
        ok: false,
        error: `No validator for "${serverId}" yet — only Brave Search can be tested in v1.`,
      };
  }
}

async function validateBrave(): Promise<McpValidationResult> {
  const entry = builtinMcpServerById('brave-search');
  const envVar = entry?.requiresSecret?.envVar ?? 'BRAVE_API_KEY';
  const secrets = await readMcpSecrets();
  // Prefer the stored key; fall back to the ambient env (the no-store path).
  const key = secrets['brave-search']?.[envVar] ?? process.env[envVar];
  if (!key) {
    return { ok: false, error: 'No Brave API key stored or detected in the environment.' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      'https://api.search.brave.com/res/v1/web/search?q=lattice+mcp+test&count=1',
      {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': key,
        },
        signal: controller.signal,
      },
    ).finally(() => clearTimeout(timer));

    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Brave rejected the key (401/403). Check the value.' };
    }
    if (res.status === 429) {
      return { ok: false, error: 'Key works but is rate-limited (429) right now.' };
    }
    return { ok: false, error: `Brave returned HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, error: `Could not reach Brave: ${(err as Error).message}` };
  }
}
