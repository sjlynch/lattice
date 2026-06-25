// Defensive shape validation for the MCP fields of globalSettings.json.
//
// `mcpCustomServers` (user-added servers) and `mcpBuiltinOverrides` (per-id
// partial edits of built-in catalog entries) arrive as untrusted JSON off the
// /api/global-settings PATCH. These parsers keep only the fields the MCP
// resolver actually reads (see ./catalog.ts + ./registry.ts) and drop unknown
// junk rather than persisting it. Split out of globalSettings.ts (the
// read/write facade) so the long defensive parsers live next to the
// McpServerEntry shape they validate. Exercised directly by
// __tests__/mcp.test.ts.

import type { McpServerEntry } from './catalog.js';

// Defensive shape validation for user-supplied custom MCP servers. Keeps only
// well-formed entries with the fields the resolver reads; unknown junk is
// dropped rather than trusted. Exported for unit testing.
export function sanitizeCustomServers(raw: unknown): McpServerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    const transport = e.transport === 'http' ? 'http' : 'stdio';
    const support = (e.harnessSupport ?? {}) as Record<string, unknown>;
    const entry: McpServerEntry = {
      id: e.id,
      label: typeof e.label === 'string' ? e.label : e.id,
      description: typeof e.description === 'string' ? e.description : '',
      transport,
      runtime:
        e.runtime === 'uv' || e.runtime === 'docker' || e.runtime === 'remote'
          ? e.runtime
          : 'node',
      harnessSupport: {
        claude: support.claude !== false,
        codex: support.codex === true,
        pi: support.pi === true,
      },
      builtin: false,
    };
    if (typeof e.command === 'string') entry.command = e.command;
    if (Array.isArray(e.args)) entry.args = e.args.filter((a) => typeof a === 'string');
    if (e.env && typeof e.env === 'object') entry.env = stringRecord(e.env);
    if (typeof e.url === 'string') entry.url = e.url;
    if (e.headers && typeof e.headers === 'object') entry.headers = stringRecord(e.headers);
    if (Array.isArray(e.secretEnvVars)) {
      entry.secretEnvVars = e.secretEnvVars.filter((v) => typeof v === 'string');
    }
    if (typeof e.runtimeNote === 'string') entry.runtimeNote = e.runtimeNote;
    if (e.requiresSecret && typeof e.requiresSecret === 'object') {
      const rs = e.requiresSecret as Record<string, unknown>;
      if (typeof rs.envVar === 'string') {
        entry.requiresSecret = {
          envVar: rs.envVar,
          label: typeof rs.label === 'string' ? rs.label : rs.envVar,
          ...(typeof rs.getKeyUrl === 'string' ? { getKeyUrl: rs.getKeyUrl } : {}),
        };
      }
    }
    out.push(entry);
  }
  return out;
}

// A built-in override may only TWEAK a catalog entry — never re-point what it
// runs. `command` and `url` are deliberately DROPPED here (not just unknown
// junk): a built-in's runner lives in code (catalog.ts), which is the whole
// point of "definitions live in code". Letting an override swap `command`/`url`
// silently turned "toggle a known-safe built-in" into "run an arbitrary
// command / hit an arbitrary endpoint" the moment that built-in was enabled
// per-project — a trust escalation reachable by anyone who can PATCH
// /api/global-settings, with no allow-list in the way. So only the safe tuning /
// presentational fields survive: args, env, headers, runtimeNote. To change
// what a server runs, edit the catalog or add a custom server (which is
// builtin:false and gated as untrusted).
export function sanitizeBuiltinOverrides(
  raw: unknown,
): Record<string, Partial<McpServerEntry>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Partial<McpServerEntry>> = {};
  for (const [id, ov] of Object.entries(raw as Record<string, unknown>)) {
    if (!ov || typeof ov !== 'object') continue;
    const o = ov as Record<string, unknown>;
    const partial: Partial<McpServerEntry> = {};
    // command / url are intentionally omitted — see the header note.
    if (Array.isArray(o.args)) partial.args = o.args.filter((a) => typeof a === 'string');
    if (o.env && typeof o.env === 'object') partial.env = stringRecord(o.env);
    if (o.headers && typeof o.headers === 'object') partial.headers = stringRecord(o.headers);
    if (typeof o.runtimeNote === 'string') partial.runtimeNote = o.runtimeNote;
    if (Object.keys(partial).length > 0) out[id] = partial;
  }
  return out;
}

// Keep only the string-valued keys of an object (env / headers maps).
function stringRecord(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
