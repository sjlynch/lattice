// The three per-harness shapers over the pure core (`resolveEntries.ts`): the
// enabled entry set → Claude `mcpServers` map, Codex `-c` overrides + secret
// env, Pi `.pi/mcp.json` map + secret env. Pure; `registry.ts` re-exports all
// of it and wraps it in the async spawn-path resolvers.

import type { AgentHarness } from '../harnesses.js';
import type { McpSecrets } from './secrets.js';
import type { McpServerEntry } from './catalog.js';
import { UnsafeCmdArgumentError, type ClaudeMcpServerConfig } from './claudeInject.js';
import { toClaudeConfig } from './claudeServerConfig.js';
import { safeCodexServerId, toCodexServerConfig } from './codexServerConfig.js';
import { toPiServerConfig, type PiMcpServerConfig } from './piServerConfig.js';
import { resolveMcpEntries, type McpResolveContext, type ResolveSettings } from './resolveEntries.js';

// Claude shaper: enabled entry set → Claude `mcpServers` config. Thin wrapper
// over the neutral core; kept as the stable name the Claude apply path imports.
export function resolveClaudeServers(
  catalog: McpServerEntry[],
  settings: ResolveSettings,
  secrets: McpSecrets,
  ctx: McpResolveContext = {},
): Record<string, ClaudeMcpServerConfig> {
  const out: Record<string, ClaudeMcpServerConfig> = {};
  for (const { entry, serverSecrets, headless } of resolveMcpEntries(
    catalog,
    settings,
    secrets,
    'claude',
    ctx,
  )) {
    const shaped = shapeOrSkip('claude', entry.id, () =>
      toClaudeConfig(entry, serverSecrets, headless),
    );
    if (shaped) out[entry.id] = shaped;
  }
  return out;
}

// Run one shaper, skipping (with a warning) a server whose args can't be carried
// safely through the win32 `cmd /c` wrap — see `escapeCmdArgument` in
// claudeInject.ts. One bad custom server must not take the other servers (or
// the spawn) down with it. Any other error still propagates.
function shapeOrSkip<T>(harness: AgentHarness, id: string, shape: () => T): T | null {
  try {
    return shape();
  } catch (err) {
    if (!(err instanceof UnsafeCmdArgumentError)) throw err;
    console.warn(`[mcp] ${harness}: skipping server "${id}" — ${err.message}`);
    return null;
  }
}

// The resolved Codex spawn payload: one inline-TOML `-c` override string per
// enabled server (the terminal-server turns each into a `--config` arg with
// shell-correct env-var referencing) and the secret env the child pty carries.
export type CodexMcpResolution = {
  configArgs: string[];
  env: Record<string, string>;
};

// Codex shaper: enabled entry set → `-c` override args + secret env. Codex has
// no QA-scoped Playwright, so ctx is always the default.
export function resolveCodexServers(
  catalog: McpServerEntry[],
  settings: ResolveSettings,
  secrets: McpSecrets,
  ctx: McpResolveContext = {},
): CodexMcpResolution {
  const configArgs: string[] = [];
  const env: Record<string, string> = {};
  // The Codex key is a lossy fold of the catalog id (`my-api` and `my_api` both
  // become `lattice_my_api`), and so are the secret env-var names. A second
  // server landing on a taken key would silently replace the first (or hand it
  // the other server's secret), so it is skipped with a warning instead.
  const keyOwner = new Map<string, string>();
  for (const { entry, serverSecrets, headless } of resolveMcpEntries(
    catalog,
    settings,
    secrets,
    'codex',
    ctx,
  )) {
    const key = safeCodexServerId(entry.id);
    const owner = keyOwner.get(key);
    if (owner !== undefined) {
      console.warn(
        `[mcp] codex: skipping server "${entry.id}" — its Codex key ${key} collides with "${owner}"`,
      );
      continue;
    }
    const shaped = shapeOrSkip('codex', entry.id, () =>
      toCodexServerConfig(entry, serverSecrets, headless),
    );
    if (!shaped) continue;
    if (skipOnEnvClash('codex', entry.id, env, shaped.env)) continue;
    keyOwner.set(key, entry.id);
    configArgs.push(shaped.configArg);
    Object.assign(env, shaped.env);
  }
  return { configArgs, env };
}

// The first var name in `incoming` that `env` already holds with a DIFFERENT
// value — the same name with the same value is harmless (one secret shared by
// two servers), a different value would cross one server's secret into the
// other. Undefined when there is no such clash.
function envNameClash(
  env: Record<string, string>,
  incoming: Record<string, string>,
): string | undefined {
  for (const [name, value] of Object.entries(incoming)) {
    if (name in env && env[name] !== value) return name;
  }
  return undefined;
}

// True (after warning) when server `id`'s secret env would clash with one
// already claimed in `env` — the caller skips that server.
function skipOnEnvClash(
  harness: 'codex' | 'pi',
  id: string,
  env: Record<string, string>,
  incoming: Record<string, string>,
): boolean {
  const clash = envNameClash(env, incoming);
  if (!clash) return false;
  console.warn(
    `[mcp] ${harness}: skipping server "${id}" — its secret env var ${clash} is already ` +
      'claimed by another server with a different value',
  );
  return true;
}

// The resolved Pi spawn payload: the `mcpServers` map for `<cwd>/.pi/mcp.json`
// (server id → config, read by pi-mcp-adapter) and the secret env the child
// pty carries (stdio secrets the adapter inherits via process.env).
export type PiMcpResolution = {
  mcpServers: Record<string, PiMcpServerConfig>;
  env: Record<string, string>;
};

// Pi shaper: enabled entry set → `.pi/mcp.json` server map + secret env. Like
// Codex, Pi has no QA-scoped Playwright.
export function resolvePiServers(
  catalog: McpServerEntry[],
  settings: ResolveSettings,
  secrets: McpSecrets,
  ctx: McpResolveContext = {},
): PiMcpResolution {
  const mcpServers: Record<string, PiMcpServerConfig> = {};
  const env: Record<string, string> = {};
  for (const { entry, serverSecrets, headless } of resolveMcpEntries(
    catalog,
    settings,
    secrets,
    'pi',
    ctx,
  )) {
    const shaped = shapeOrSkip('pi', entry.id, () => toPiServerConfig(entry, serverSecrets, headless));
    if (!shaped) continue;
    // The map is keyed by the exact id, but secret-header env-var names are a
    // lossy fold shared with Codex (`my-api` / `my_api` → the same var): a
    // second server would overwrite the first's secret in the pty env.
    if (skipOnEnvClash('pi', entry.id, env, shaped.env)) continue;
    mcpServers[entry.id] = shaped.config;
    Object.assign(env, shaped.env);
  }
  return { mcpServers, env };
}
