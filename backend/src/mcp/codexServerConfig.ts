// Codex config shaping: turn a single resolved catalog entry into a Codex
// per-invocation `-c "mcp_servers.<id>={…}"` inline-TOML override plus the
// secret env the child pty must carry. Pure — no I/O. The Codex analogue of
// `claudeServerConfig.ts`.
//
// Why inline-TOML `-c` overrides and not a written `~/.codex/config.toml`:
// exactly the reasoning behind `terminal/codexTrust.ts`'s trust override — a
// server enabled for a Lattice-orchestrated Codex agent must not silently
// appear in Codex sessions the user launches elsewhere. Codex's documented
// `--config key=value` (value parsed as TOML) lets us ADD servers for one
// invocation without touching the user's global config.
//
// Secret transport (verified against codex-cli 0.144.1):
//   - stdio secret env  → listed by NAME in `env_vars`; the VALUE rides only in
//     the child pty env (returned here as `env`), never in the argv/TOML.
//   - HTTP secret header → mapped in `env_http_headers` (header → env-var NAME);
//     bearer token → `bearer_token_env_var`. Same rule: names in argv, values
//     in pty env.
// Static (non-secret) env / headers are emitted inline in `env` / `http_headers`.
//
// The dotted `mcp_servers.<id>=…` form MERGES one key into the user's table,
// leaving the user's own servers alone. (A whole-table `mcp_servers={…}` does
// not replace config.toml's table either — Codex merges the `-c` layer over it —
// which is why the task-worktree scope disables user servers by name instead;
// see taskWorktreeScope.ts.) Generated ids are namespaced `lattice_*` and underscore-only —
// dashed / quoted dotted segments are unreliable through the Windows PowerShell
// path (see the plan §4).

import type { McpServerEntry } from './catalog.js';
import { platformizeCommand } from './claudeInject.js';
import { secretEnvVarsFor } from './claudeServerConfig.js';

// Result of shaping one entry: the `-c` override string (sans the `--config`
// flag — the terminal-server adds that with shell-correct env-var referencing)
// and the secret env values the pty must carry for this server.
export type CodexServerConfig = {
  // e.g. `mcp_servers.lattice_playwright={command="cmd", args=[…]}`
  configArg: string;
  // Secret env var name → value, to merge into the child pty env only.
  env: Record<string, string>;
};

// Map a catalog id (may contain dashes: `brave-search`) to an
// underscore-only Codex server key. Namespaced `lattice_` so it never shadows a
// user's own server and is obviously Lattice-managed. The fold is lossy — `-`,
// `.`, space and case all become `_`, so `my-api` and `my_api` share a key; the
// Codex resolver (`registry.ts` resolveCodexServers) detects that and skips the
// second rather than letting one silently replace the other.
export function safeCodexServerId(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `lattice_${cleaned || 'server'}`;
}

// --- Minimal TOML value rendering (the shapes we emit only) ------------------
// CRITICAL (Windows cmd.exe): the whole override rides in a child-env var the
// command references as `"%VAR%"`. cmd STRIPS inner double-quotes out of a
// `"%VAR%"` expansion (verified: `command="cmd"` → `command=cmd`, which Codex
// then rejects), but PRESERVES single-quotes. So we render TOML **single-quoted
// literal strings** (`'…'`), which survive cmd, PowerShell (`"$env:VAR"`), and
// POSIX (`"$VAR"`) identically. TOML literal strings have no escapes and cannot
// contain a `'`; for the rare value that does, we fall back to a double-quoted
// basic string (correct on PowerShell/POSIX, degraded only on cmd for that one
// value — still strictly better than no Codex MCP).

// Exported so the Codex system-prompt injector (harnessSystemPrompts/inject.ts)
// renders its file-path value with the identical cmd-safe quoting. Prefer this
// for controlled strings (commands/args/urls/paths) that essentially never
// contain a `'`; for free prose that commonly does, use a multi-line literal
// instead so the `'`-fallback to a double-quoted string never fires.
export function tomlString(s: string): string {
  return NEEDS_BASIC_STRING.test(s) ? JSON.stringify(s) : `'${s}'`;
}

// What a TOML literal string cannot carry: the `'` that would close it, and
// every control character except tab (a newline in a single-quoted literal is
// invalid TOML — the whole `-c` override, and with it the Codex spawn, used to
// fail on one such value). JSON escapes are valid TOML basic-string escapes, so
// JSON.stringify is the right fallback for all of them.
const NEEDS_BASIC_STRING = /['\x00-\x08\x0A-\x1F\x7F]/;

function tomlStringArray(arr: string[]): string {
  return `[${arr.map(tomlString).join(', ')}]`;
}

// A bare TOML key allows [A-Za-z0-9_-]; anything else (e.g. a header name with a
// dot or space) is a quoted key — single-quoted for the same cmd reason.
function tomlKey(k: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return NEEDS_BASIC_STRING.test(k) ? JSON.stringify(k) : `'${k}'`;
}

// Inline table of string values: `{ K="v", "X-Y"="z" }`. Empty → `{}`.
function tomlStringTable(obj: Record<string, string>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`);
  return `{${parts.join(', ')}}`;
}

// Assemble one `key=value` field, skipping empties so a bare server stays lean.
function fields(pairs: Array<[string, string | undefined]>): string {
  return pairs
    .filter((p): p is [string, string] => p[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

// Shape one enabled entry into its Codex `-c` override + secret env. `headless`
// is only meaningful for the Playwright entry (appends `--headless`).
export function toCodexServerConfig(
  entry: McpServerEntry,
  serverSecrets: Record<string, string> | undefined,
  headless: boolean,
): CodexServerConfig {
  const key = safeCodexServerId(entry.id);
  const env: Record<string, string> = {};

  if (entry.transport === 'http') {
    const staticHeaders: Record<string, string> = { ...(entry.headers ?? {}) };
    const envHeaders: Record<string, string> = {};
    // Each secret header: value → pty env (a collision-resistant var name),
    // header → that var NAME in env_http_headers. The literal never hits argv.
    for (const name of entry.secretHeaders ?? []) {
      const value = serverSecrets?.[name];
      if (!value) continue; // unfilled placeholder → omit (user still supplies)
      const varName = secretHeaderEnvVar(entry.id, name);
      env[varName] = value;
      envHeaders[name] = varName;
    }
    const body = fields([
      ['url', tomlString(entry.url ?? '')],
      ['http_headers', Object.keys(staticHeaders).length ? tomlStringTable(staticHeaders) : undefined],
      ['env_http_headers', Object.keys(envHeaders).length ? tomlStringTable(envHeaders) : undefined],
    ]);
    return { configArg: `mcp_servers.${key}={${body}}`, env };
  }

  // stdio
  let args = [...(entry.args ?? [])];
  if (entry.id === 'playwright' && headless) args = [...args, '--headless'];
  const { command, args: pArgs } = platformizeCommand(entry.command ?? '', args);

  const staticEnv: Record<string, string> = { ...(entry.env ?? {}) };
  const envVarNames: string[] = [];
  // Secret stdio env: value → pty env under its real name; name → env_vars so
  // Codex forwards it from the parent (pty) env to the MCP server. Static
  // (non-secret) env stays inline.
  //
  // The NAME is listed even when no value is stored (the "ambient" path: the
  // key lives in the user's shell env). Unlike Claude/Pi, Codex does not let a
  // stdio MCP server inherit the parent env — it starts the server from a
  // cleared env holding only a small default set (PATH, HOME, …) plus `env`
  // and the names in `env_vars`. Omitting the name therefore meant an ambient
  // BRAVE_API_KEY never reached the server. A listed name that is unset in the
  // parent is simply skipped, so listing it is harmless.
  for (const varName of secretEnvVarsFor(entry)) {
    envVarNames.push(varName);
    const value = serverSecrets?.[varName];
    if (value) env[varName] = value;
  }

  const body = fields([
    ['command', tomlString(command)],
    ['args', pArgs.length ? tomlStringArray(pArgs) : undefined],
    ['env', Object.keys(staticEnv).length ? tomlStringTable(staticEnv) : undefined],
    ['env_vars', envVarNames.length ? tomlStringArray(envVarNames) : undefined],
  ]);
  return { configArg: `mcp_servers.${key}={${body}}`, env };
}

// Deterministic env var name for a secret HTTP header value. Uppercased server
// id + header, non-alnum → `_`. Exported so the Pi shaper reuses the identical
// naming (a server enabled for both Codex and Pi then carries the same secret
// env-var name in the pty). Lossy like safeCodexServerId (`my-api` / `my_api`
// collide) — the Codex and Pi resolvers refuse to let a second server's secret
// overwrite a var name already claimed by another.
export function secretHeaderEnvVar(serverId: string, headerName: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `LATTICE_MCP_${norm(serverId)}_${norm(headerName)}`;
}
