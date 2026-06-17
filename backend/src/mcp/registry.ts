// The MCP control plane's resolver. Merges the code catalog with the user's
// global custom servers / built-in overrides, decides which are enabled for a
// given project, folds in stored secrets, and shapes the result per harness.
//
// `effectiveMcpServers(projectPath, harness)` is what the spawn path calls; the
// merged-catalog helpers back the settings/MCP tab and config import.

import type { AgentHarness } from '../harnesses.js';
import type { UserSettings } from '../userSettings.js';
import { getGlobalSettings } from '../globalSettings.js';
import { getUserSettings } from '../userSettings.js';
import { readMcpSecrets, type McpSecrets } from './secrets.js';
import {
  BUILTIN_MCP_SERVERS,
  type McpHarnessSupport,
  type McpServerEntry,
} from './catalog.js';
import {
  platformizeCommand,
  type ClaudeMcpServerConfig,
} from './claudeInject.js';

// The full catalog the user sees: built-ins (with any per-id override applied),
// followed by user-added custom servers. Pure-ish: only reads global settings.
export async function mergedCatalog(): Promise<McpServerEntry[]> {
  const global = await getGlobalSettings();
  const overrides = global.mcpBuiltinOverrides ?? {};
  const custom = global.mcpCustomServers ?? [];

  const builtins = BUILTIN_MCP_SERVERS.map((entry) => {
    const ov = overrides[entry.id];
    // Built-ins stay builtin:true and keep their id; an override can tweak
    // command/args/env/url/headers but not flip identity.
    return ov ? { ...entry, ...ov, id: entry.id, builtin: true } : entry;
  });

  // Custom servers can't shadow a built-in id; if they collide, the built-in wins.
  const builtinIds = new Set(builtins.map((b) => b.id));
  const customClean = custom
    .filter((c) => c && typeof c.id === 'string' && !builtinIds.has(c.id))
    .map((c) => ({ ...c, builtin: false as const }));

  return [...builtins, ...customClean];
}

function harnessSupports(support: McpHarnessSupport, harness: AgentHarness): boolean {
  return support?.[harness] === true;
}

// Is this server turned on for this project? Playwright is driven by the QA-lane
// toggle (`qaPlaywright.enabled`); everything else by `mcpOverrides[id]`. Both
// default OFF — a missing entry is always off (the all-off-by-default invariant).
function isServerEnabled(
  entry: McpServerEntry,
  overrides: Record<string, boolean> | undefined,
  qaEnabled: boolean,
): boolean {
  if (entry.id === 'playwright') return qaEnabled;
  return overrides?.[entry.id] === true;
}

// All env vars whose values come from the secrets file for this entry: the
// declared built-in key plus any imported-custom-server secret vars.
function secretEnvVarsFor(entry: McpServerEntry): string[] {
  const vars = new Set(entry.secretEnvVars ?? []);
  if (entry.requiresSecret) vars.add(entry.requiresSecret.envVar);
  return [...vars];
}

// Build the Claude per-server config for an enabled entry, folding in secrets
// and the Playwright headless flag.
function toClaudeConfig(
  entry: McpServerEntry,
  serverSecrets: Record<string, string> | undefined,
  qaHeadless: boolean,
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
  // Playwright's headless flag rides on the QA toggle, not on stored args.
  if (entry.id === 'playwright' && qaHeadless) args = [...args, '--headless'];

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

// The PURE resolver core: given the already-loaded catalog, project settings,
// and secrets, decide the enabled Claude server set. No I/O — this is the unit
// of logic worth testing exhaustively (all-off default, qaPlaywright →
// Playwright + headless flag, secret inject-vs-omit, harnessSupport filter,
// custom merge). `effectiveMcpServers` is the thin I/O wrapper around it.
export function resolveClaudeServers(
  catalog: McpServerEntry[],
  settings: Pick<UserSettings, 'mcpOverrides' | 'qaPlaywright'>,
  secrets: McpSecrets,
): Record<string, ClaudeMcpServerConfig> {
  const qa = settings.qaPlaywright;
  const qaEnabled = qa?.enabled === true;
  const qaHeadless = qa?.headless !== false; // default headless when on

  const out: Record<string, ClaudeMcpServerConfig> = {};
  for (const entry of catalog) {
    if (!isServerEnabled(entry, settings.mcpOverrides, qaEnabled)) continue;
    if (!harnessSupports(entry.harnessSupport, 'claude')) continue;
    out[entry.id] = toClaudeConfig(entry, secrets[entry.id], qaHeadless);
  }
  return out;
}

// The spawn-path resolver: server name → Claude config for everything enabled
// for `projectPath` and supported by `harness`. Returns {} for harnesses without
// MCP support yet (codex v2, pi until the plugin lands).
export async function effectiveMcpServers(
  projectPath: string,
  harness: AgentHarness,
): Promise<Record<string, ClaudeMcpServerConfig>> {
  // v1 only injects into Claude; short-circuit other harnesses.
  if (harness !== 'claude') return {};

  const [catalog, settings, secrets] = await Promise.all([
    mergedCatalog(),
    getUserSettings(projectPath),
    readMcpSecrets(),
  ]);
  return resolveClaudeServers(catalog, settings, secrets);
}
