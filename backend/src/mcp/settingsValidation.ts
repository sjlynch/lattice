// Defensive shape validation for the MCP fields of globalSettings.json.
//
// `mcpCustomServers` (user-added servers) and `mcpBuiltinOverrides` (per-id
// partial edits of built-in catalog entries) arrive as untrusted JSON off the
// /api/global-settings PATCH. These parsers keep only the fields the MCP
// resolver actually reads (see ./catalog.ts + ./registry.ts) and drop unknown
// junk rather than persisting it. Split out of globalSettings.ts (the
// read/write facade) so the long defensive parsers live next to the
// McpServerEntry shape they validate. Exercised directly by
// __tests__/mcp*.test.ts.

import type { McpServerEntry } from './catalog.js';
// The env code-injection / launcher-hijack denylist lives on its own — an
// override may TUNE a built-in but never re-point what it runs. See
// ./overrideSecurity.ts.
import { isUnsafeOverrideArg, sanitizeOverrideEnv } from './overrideSecurity.js';

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
    // Header names whose VALUES live in ~/.lattice/mcpSecrets.json (an imported
    // HTTP server's auth header — see mcp/import/normalize.ts). Carried through
    // so the resolver re-injects the stored value at spawn time; the literal
    // never sits inline here.
    if (Array.isArray(e.secretHeaders)) {
      entry.secretHeaders = e.secretHeaders.filter((v) => typeof v === 'string');
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
// runs. Three layers enforce that:
//   1. `command` and `url` are DROPPED here (a built-in's runner lives in code —
//      catalog.ts — which is the whole point of "definitions live in code").
//   2. `env` is filtered through sanitizeOverrideEnv so an override can't inject
//      a code-exec / launcher-hijack var (NODE_OPTIONS, LD_PRELOAD, PATH, …).
//   3. `args` survive as a string array HERE, but the additive-only guard that
//      stops them replacing the npx package spec / launcher args lives in
//      `applyBuiltinOverride` (it needs the catalog base to compare against).
// Together these stop "toggle a known-safe built-in" from becoming "run an
// arbitrary command / inject code" for anyone who can PATCH /api/global-settings.
// To change what a server runs, edit the catalog or add a custom server (which
// is builtin:false and gated as untrusted).
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
    if (o.env && typeof o.env === 'object') {
      const env = sanitizeOverrideEnv(o.env);
      if (Object.keys(env).length > 0) partial.env = env;
    }
    if (o.headers && typeof o.headers === 'object') partial.headers = stringRecord(o.headers);
    if (typeof o.runtimeNote === 'string') partial.runtimeNote = o.runtimeNote;
    if (Object.keys(partial).length > 0) out[id] = partial;
  }
  return out;
}

// Apply a (already shape-sanitized) built-in override onto its catalog entry.
// The override may only tune safe fields; it can never re-point what the server
// runs:
//   - id / command / url / builtin always come from the catalog (base), re-pinned
//     so neither a crafted override nor a future field addition can swap them.
//   - `args` are ADDITIVE-ONLY: the override must reproduce every catalog arg in
//     order (the `-y` launcher flag + the package spec) and may then append safe
//     flags (e.g. Playwright `--browser firefox`). Any replacement — a different
//     package spec, a dropped `-y`, a shorter/rewritten array — is rejected and
//     the catalog args stand. So an override can add a browser flag but cannot
//     turn `npx -y @playwright/mcp@latest` into `npx -y evil-pkg`.
//   - `env` / `headers` / `runtimeNote` are folded in (env already had its
//     code-exec / launcher-hijack keys stripped by sanitizeBuiltinOverrides).
// Used by registry.mergedCatalog; exported for unit testing.
export function applyBuiltinOverride(
  base: McpServerEntry,
  override: Partial<McpServerEntry>,
): McpServerEntry {
  const merged: McpServerEntry = { ...base };

  if (Array.isArray(override.args)) {
    merged.args = mergeOverrideArgs(base.args ?? [], override.args, base.id);
  }
  if (override.env) merged.env = { ...(base.env ?? {}), ...override.env };
  if (override.headers) merged.headers = { ...(base.headers ?? {}), ...override.headers };
  if (typeof override.runtimeNote === 'string') merged.runtimeNote = override.runtimeNote;

  // Identity + runner are immutable — re-pin from the catalog last so an override
  // (or a future spread) can never replace them.
  merged.id = base.id;
  merged.command = base.command;
  merged.url = base.url;
  merged.builtin = true;
  return merged;
}

// Additive-only arg merge: the override must preserve every catalog arg in order,
// then may append. Otherwise it's trying to replace the runner — reject it and
// keep the catalog args. (When the catalog entry has no args there's nothing to
// protect, so the override's flags apply as-is.) An appended flag that points
// the server at an arbitrary binary (`--executable-path` & co., see
// overrideSecurity.ts `isUnsafeOverrideArg`) rejects the whole override the
// same way — the catalog args stand, rather than keeping a half-stripped list
// whose orphaned path value would read as a stray positional.
function mergeOverrideArgs(
  baseArgs: string[],
  overrideArgs: string[],
  serverId: string,
): string[] {
  const preservesBase =
    overrideArgs.length >= baseArgs.length &&
    baseArgs.every((a, i) => overrideArgs[i] === a);
  if (!preservesBase) return baseArgs;
  const appended = overrideArgs.slice(baseArgs.length);
  if (appended.some((a) => isUnsafeOverrideArg(a, serverId))) return baseArgs;
  return overrideArgs;
}

// Keep only the string-valued keys of an object (env / headers maps).
function stringRecord(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
