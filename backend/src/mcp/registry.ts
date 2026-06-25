// The MCP control plane's resolver facade. Merges the code catalog with the
// user's global custom servers / built-in overrides, decides which are enabled
// for a given project, folds in stored secrets, and shapes the result per
// harness. This file owns the catalog merge + the resolve orchestration; the
// per-decision logic lives in focused pure helpers it composes:
//   - `resolverPolicy.ts`     — Playwright enable/headless policy.
//   - `claudeServerConfig.ts` — secret-env selection + Claude config shaping.
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
import type { ClaudeMcpServerConfig } from './claudeInject.js';
import { resolvePlaywright } from './resolverPolicy.js';
import { toClaudeConfig } from './claudeServerConfig.js';
import { applyBuiltinOverride } from './settingsValidation.js';

// The full catalog the user sees: built-ins (with any per-id override applied),
// followed by user-added custom servers. Pure-ish: only reads global settings.
export async function mergedCatalog(): Promise<McpServerEntry[]> {
  const global = await getGlobalSettings();
  const overrides = global.mcpBuiltinOverrides ?? {};
  const custom = global.mcpCustomServers ?? [];

  const builtins = BUILTIN_MCP_SERVERS.map((entry) => {
    const ov = overrides[entry.id];
    // Built-ins stay builtin:true and keep their id/command/url; an override may
    // tweak only the safe fields. `applyBuiltinOverride` re-pins identity + the
    // runner from the catalog and enforces the additive-only args rule, so an
    // override can't re-point what the built-in runs (sanitizeBuiltinOverrides
    // already dropped command/url and any code-exec env on the read path).
    return ov ? applyBuiltinOverride(entry, ov) : entry;
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

// Context for a single resolve, distinguishing the kind of session being
// spawned. Today it carries only `isQaRun` — see `resolvePlaywright`
// (`resolverPolicy.ts`).
export type McpResolveContext = {
  // True ONLY for the QA-lane "run an e2e test" sessions. Gates the QA-scoped
  // Playwright enablement (`qaPlaywright`), which must NOT leak into ordinary
  // task / sidebar / push / workflow sessions — those get Playwright only via
  // the global `mcpOverrides.playwright` toggle.
  isQaRun?: boolean;
};

// The PURE resolver core: given the already-loaded catalog, project settings,
// secrets, and spawn context, decide the enabled Claude server set. No I/O —
// this is the unit of logic worth testing exhaustively (all-off default, global
// vs QA-only Playwright + headless flag, secret inject-vs-omit, harnessSupport
// filter, custom merge). `effectiveMcpServers` is the thin I/O wrapper around it.
export function resolveClaudeServers(
  catalog: McpServerEntry[],
  settings: Pick<UserSettings, 'mcpOverrides' | 'qaPlaywright'>,
  secrets: McpSecrets,
  ctx: McpResolveContext = {},
): Record<string, ClaudeMcpServerConfig> {
  const isQaRun = ctx.isQaRun === true;

  const out: Record<string, ClaudeMcpServerConfig> = {};
  for (const entry of catalog) {
    if (!harnessSupports(entry.harnessSupport, 'claude')) continue;
    if (entry.id === 'playwright') {
      // Playwright has two scopes (global vs QA-only) and a computed headless
      // flag, so it doesn't go through the plain `mcpOverrides` gate.
      const pw = resolvePlaywright(settings, isQaRun);
      if (!pw.enabled) continue;
      out[entry.id] = toClaudeConfig(entry, secrets[entry.id], pw.headless);
    } else {
      // Everything else: the per-project `mcpOverrides[id]` toggle, default OFF.
      if (settings.mcpOverrides?.[entry.id] !== true) continue;
      out[entry.id] = toClaudeConfig(entry, secrets[entry.id], false);
    }
  }
  return out;
}

// The spawn-path resolver: server name → Claude config for everything enabled
// for `projectPath` and supported by `harness`. Returns {} for harnesses without
// MCP support yet (codex v2, pi until the plugin lands). `ctx.isQaRun` opts the
// spawn into the QA-scoped Playwright (see `resolvePlaywright`); omit it for
// ordinary sessions (task / sidebar / push / workflow / project-root reconcile).
export async function effectiveMcpServers(
  projectPath: string,
  harness: AgentHarness,
  ctx: McpResolveContext = {},
): Promise<Record<string, ClaudeMcpServerConfig>> {
  // v1 only injects into Claude; short-circuit other harnesses.
  if (harness !== 'claude') return {};

  const [catalog, settings, secrets] = await Promise.all([
    mergedCatalog(),
    getUserSettings(projectPath),
    readMcpSecrets(),
  ]);
  return resolveClaudeServers(catalog, settings, secrets, ctx);
}

// Best-effort variant for the spawn chokepoint: resolve the managed Claude
// servers for `projectPath`, returning `null` instead of throwing so a resolve
// failure degrades to a trust-only seed and never blocks a spawn. The MAIN
// backend calls this (in `terminalServerClient.proxyCreateSession` and the
// project-instrumentation route) and passes the result to the terminal-server,
// which only APPLIES it (`claudeTrust.applyClaudeProjectConfig`). Keeping the
// resolution here — out of the long-lived detached terminal-server — means a
// spawn-policy change is a backend-only edit (no terminal-server respawn, never
// stale). See mcp/CLAUDE.md "Injection sites".
export async function resolveManagedClaudeServers(
  projectPath: string,
  ctx: McpResolveContext = {},
): Promise<Record<string, ClaudeMcpServerConfig> | null> {
  try {
    return await effectiveMcpServers(projectPath, 'claude', ctx);
  } catch (err) {
    console.warn(
      `[mcp] resolve failed for ${projectPath}: ${(err as Error).message}`,
    );
    return null;
  }
}
