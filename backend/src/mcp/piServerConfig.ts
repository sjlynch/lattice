// Pi config shaping: turn a resolved catalog entry into a `pi-mcp-adapter`
// server config (the `mcpServers` value written to `<cwd>/.pi/mcp.json`) plus
// the secret env the child pty carries. Pure — no I/O. The Pi analogue of
// `claudeServerConfig.ts` / `codexServerConfig.ts`.
//
// Mechanism (see mcp/CLAUDE.md + the migration in plans/): Pi has no native MCP.
// Lattice loads the third-party `pi-mcp-adapter` (a private, Lattice-owned
// install — never the user's global Pi config) which auto-discovers standard MCP
// config files, `<cwd>/.pi/mcp.json` among them (`{"mcpServers":{…}}`). Both the
// extension shim and the config file are dropped into the Lattice-spawned Pi
// session's cwd (cwd-exact discovery, like the pi-subagents shim). No command
// rewriting is needed.
//
// Secret transport:
//   - stdio secret env → VALUE rides only in the pty env (returned here as
//     `env`) and is OMITTED from the JSON file. The adapter's `resolveEnv` copies
//     the child's `process.env` before applying per-server `env`, so the MCP
//     child inherits it (same as before).
//   - HTTP header secret → the adapter DOES interpolate `${VAR}` / `$env:VAR` in
//     `headers` (and `env`, `url`, `bearerToken`, `cwd`). So a secret header is
//     written as a `${VAR}` REFERENCE (never the literal) with the VALUE in the
//     pty env — lifting the prior `pi-mcp-extension` limitation where secret
//     headers had to be dropped.
//
// `directTools: true` registers each server's tools as individual Pi tools
// (alongside `read`/`bash`/…) rather than behind the adapter's single `mcp()`
// proxy — parity with the direct-tool exposure Lattice Pi sessions had before,
// and the most reliable path for an autonomous agent (no need to know the proxy
// convention). `lifecycle: 'eager'` so servers connect at session start and
// their tool metadata is available immediately (a cold worktree has no cache).

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
