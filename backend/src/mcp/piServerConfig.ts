// Pi config shaping: a resolved catalog entry → a `pi-mcp-adapter` server config
// (the `mcpServers` value written to `<cwd>/.pi/mcp.json`) plus the secret env
// the child pty carries. Pure — no I/O. The Pi analogue of
// `claudeServerConfig.ts` / `codexServerConfig.ts`.
//
// Pi has no native MCP: Lattice loads `pi-mcp-adapter` (a private, Lattice-owned
// install — never the user's global Pi config), which auto-discovers
// `<cwd>/.pi/mcp.json`; the shim and config are dropped into the spawned Pi
// session's cwd (cwd-exact discovery), so no command rewriting is needed. See
// mcp/CLAUDE.md.
//
// Secret transport — a secret VALUE is never written to the JSON file:
//   - stdio secret env → the value rides only in the pty env (returned as `env`);
//     the adapter's `resolveEnv` copies the child's `process.env` before
//     per-server `env`, so the MCP child inherits it.
//   - HTTP header secret → written as a `${VAR}` REFERENCE (the adapter
//     interpolates `${VAR}` / `$env:VAR` in `headers`, `env`, `url`,
//     `bearerToken`, `cwd`) with the value in the pty env.
//
// `directTools: true` registers each server's tools as individual Pi tools, not
// behind the adapter's single `mcp()` proxy — most reliable for an autonomous
// agent (no proxy convention to know). `lifecycle: 'eager'` connects at session
// start so tool metadata is available immediately (a cold worktree has no cache).

import type { McpServerEntry } from './catalog.js';
import { platformizeCommand } from './claudeInject.js';
import { secretEnvVarsFor } from './claudeServerConfig.js';
import { secretHeaderEnvVar } from './codexServerConfig.js';

// One `pi-mcp-adapter` server entry (subset of its schema — see the adapter's
// config.ts / README "Server Options"). Transport is inferred by the adapter
// from field presence (`command` → stdio, `url` → HTTP), so there is no
// `transport` field.
export type PiMcpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  lifecycle?: 'eager' | 'lazy' | 'keep-alive';
  directTools?: boolean | string[];
};

export type PiServerConfig = {
  config: PiMcpServerConfig;
  // Secret env var name → value, to merge into the child pty env only.
  env: Record<string, string>;
};

// Shape one enabled entry into its Pi config + secret env. `headless` is only
// meaningful for the Playwright entry (appends `--headless`).
export function toPiServerConfig(
  entry: McpServerEntry,
  serverSecrets: Record<string, string> | undefined,
  headless: boolean,
): PiServerConfig {
  if (entry.transport === 'http') {
    const headers: Record<string, string> = { ...(entry.headers ?? {}) };
    const env: Record<string, string> = {};
    // Each secret header: value → pty env (a collision-resistant var name shared
    // with the Codex shaper), header → a `${VAR}` reference the adapter
    // interpolates at spawn. The literal never lands in the JSON file.
    for (const name of entry.secretHeaders ?? []) {
      const value = serverSecrets?.[name];
      if (!value) continue; // unfilled placeholder → omit (user still supplies)
      const varName = secretHeaderEnvVar(entry.id, name);
      env[varName] = value;
      headers[name] = `\${${varName}}`;
    }
    const config: PiMcpServerConfig = {
      url: entry.url ?? '',
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      lifecycle: 'eager',
      directTools: true,
    };
    return { config, env };
  }

  let args = [...(entry.args ?? [])];
  if (entry.id === 'playwright' && headless) args = [...args, '--headless'];
  const { command, args: pArgs } = platformizeCommand(entry.command ?? '', args);

  const staticEnv: Record<string, string> = { ...(entry.env ?? {}) };
  const env: Record<string, string> = {};
  // Secret stdio env: value → pty env under its real name; OMITTED from the
  // JSON `env` (the adapter's resolveEnv merges the child's process.env, so the
  // child inherits it). No stored value → rely on the user's ambient shell env.
  for (const varName of secretEnvVarsFor(entry)) {
    const value = serverSecrets?.[varName];
    if (value) env[varName] = value;
  }

  const config: PiMcpServerConfig = {
    command,
    ...(pArgs.length > 0 ? { args: pArgs } : {}),
    ...(Object.keys(staticEnv).length > 0 ? { env: staticEnv } : {}),
    lifecycle: 'eager',
    directTools: true,
  };
  return { config, env };
}
