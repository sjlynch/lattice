// Claude config shaping: turn a single resolved catalog entry into Claude Code's
// per-server config, folding in the entry's stored secret env and the computed
// Playwright headless flag. Pure — no I/O. Kept separate from the resolver
// *policy* (`resolverPolicy.ts`) and from catalog merge / orchestration
// (`registry.ts`).
//
// Distinct from `claudeInject.ts`, which reconciles the *whole* resolved set
// into a `~/.claude.json` project entry and is imported by the terminal-server's
// apply path (and is in its fingerprint set). The resolver/secret-selection logic
// here must NOT leak into that apply-side module — see `mcp/CLAUDE.md`.

import type { McpServerEntry } from './catalog.js';
import { platformizeCommand, type ClaudeMcpServerConfig } from './claudeInject.js';

// All env vars whose values come from the secrets file for this entry: the
// declared built-in key plus any imported-custom-server secret vars.
export function secretEnvVarsFor(entry: McpServerEntry): string[] {
  const vars = new Set(entry.secretEnvVars ?? []);
  if (entry.requiresSecret) vars.add(entry.requiresSecret.envVar);
  return [...vars];
}

// Build the Claude per-server config for an enabled entry, folding in secrets
// and the Playwright headless flag. `headless` is only meaningful for the
// Playwright entry (see `resolvePlaywright`); it's ignored for every other server.
export function toClaudeConfig(
  entry: McpServerEntry,
  serverSecrets: Record<string, string> | undefined,
  headless: boolean,
): ClaudeMcpServerConfig {
  if (entry.transport === 'http') {
    return {
      type: 'http',
      url: entry.url ?? '',
      ...(entry.headers && Object.keys(entry.headers).length > 0
        ? { headers: entry.headers }
        : {}),
    };
  }

  let args = [...(entry.args ?? [])];
  // Playwright's headless flag is computed (QA-toggle or global), not stored on args.
  if (entry.id === 'playwright' && headless) args = [...args, '--headless'];

  const env: Record<string, string> = { ...(entry.env ?? {}) };
  for (const envVar of secretEnvVarsFor(entry)) {
    const value = serverSecrets?.[envVar];
    // If there's no stored value, leave the var out so the harness can inherit
    // it from the user's ambient shell (the no-store path).
    if (value) env[envVar] = value;
  }

  const { command, args: pArgs } = platformizeCommand(entry.command ?? '', args);
  return {
    type: 'stdio',
    command,
    args: pArgs,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
