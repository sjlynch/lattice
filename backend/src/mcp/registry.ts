// The MCP control plane's resolver facade. Merges the code catalog with the
// user's global custom servers / built-in overrides, decides which are enabled
// for a given project, folds in stored secrets, and shapes the result per
// harness. This file owns the catalog merge + the async spawn-path resolvers;
// the per-decision logic lives in focused pure modules it composes (and
// re-exports, so this stays the stable import path):
//   - `resolveEntries.ts`     — harness-neutral core (`resolveMcpEntries`).
//   - `harnessResolvers.ts`   — Claude / Codex / Pi shapers.
//   - `resolverPolicy.ts`     — Playwright enable/headless policy.
//   - `claudeServerConfig.ts` — secret-env selection + Claude config shaping.
//
// `effectiveMcpServers(projectPath, harness)` is what the spawn path calls; the
// merged-catalog helpers back the settings/MCP tab and config import.

import type { AgentHarness } from '../harnesses.js';
import { getGlobalSettings } from '../globalSettings.js';
import { getUserSettings } from '../userSettings.js';
import { getBackendServerConfig } from '../server/config.js';
import { readMcpSecrets, type McpSecrets } from './secrets.js';
import { BUILTIN_MCP_SERVERS, type McpServerEntry } from './catalog.js';
import type { ClaudeMcpServerConfig } from './claudeInject.js';
import { applyBuiltinOverride } from './settingsValidation.js';
import type { McpResolveContext, ResolveSettings } from './resolveEntries.js';
import {
  resolveClaudeServers,
  resolveCodexServers,
  resolvePiServers,
  type CodexMcpResolution,
  type PiMcpResolution,
} from './harnessResolvers.js';

export {
  resolveMcpEntries,
  type McpResolveContext,
  type ResolveSettings,
  type ResolvedMcpEntry,
} from './resolveEntries.js';
export {
  resolveClaudeServers,
  resolveCodexServers,
  resolvePiServers,
  type CodexMcpResolution,
  type PiMcpResolution,
} from './harnessResolvers.js';

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

// The three inputs every async resolver loads: the merged catalog, the
// project's settings (unless the caller already read them), and the secrets.
function loadResolveInputs(
  projectPath: string,
  preloadedSettings?: ResolveSettings,
): Promise<[McpServerEntry[], ResolveSettings, McpSecrets]> {
  return Promise.all([
    mergedCatalog(),
    preloadedSettings ?? getUserSettings(projectPath),
    readMcpSecrets(),
  ]);
}

// The Claude spawn-path resolver: server name → Claude config for everything
// enabled for `projectPath` and supported by Claude. `ctx.isQaRun` opts the
// spawn into the QA-scoped Playwright (see `resolvePlaywright`); omit it for
// ordinary sessions (task / sidebar / push / workflow / project-root reconcile).
// Codex/Pi have their own resolvers (`resolveManagedCodexServers` /
// `resolveManagedPiServers`) since their config shapes differ.
export async function effectiveMcpServers(
  projectPath: string,
  harness: AgentHarness,
  ctx: McpResolveContext = {},
  // The project's settings when the caller already read them (the spawn
  // chokepoint reads them once per spawn); read here otherwise.
  preloadedSettings?: ResolveSettings,
): Promise<Record<string, ClaudeMcpServerConfig>> {
  // This resolver returns CLAUDE's config shape; other harnesses shape
  // differently and go through their own resolver.
  if (harness !== 'claude') return {};

  const [catalog, settings, secrets] = await loadResolveInputs(projectPath, preloadedSettings);
  return resolveClaudeServers(catalog, settings, secrets, withSpawnContext(projectPath, ctx));
}

// Fill in the spawn-context fields the pure core can't discover for itself: the
// project being spawned for and this backend's own origin. Every async resolver
// goes through this so the `lattice` server's env is identical across harnesses.
function withSpawnContext(
  projectPath: string,
  ctx: McpResolveContext = {},
): McpResolveContext {
  return {
    ...ctx,
    projectPath: ctx.projectPath ?? projectPath,
    apiUrl: ctx.apiUrl ?? getBackendServerConfig().backendOrigin,
  };
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
  preloadedSettings?: ResolveSettings,
): Promise<Record<string, ClaudeMcpServerConfig> | null> {
  try {
    return await effectiveMcpServers(projectPath, 'claude', ctx, preloadedSettings);
  } catch (err) {
    console.warn(
      `[mcp] resolve failed for ${projectPath}: ${(err as Error).message}`,
    );
    return null;
  }
}

// Best-effort Codex analogue of `resolveManagedClaudeServers`: resolve the
// enabled Codex `-c` overrides + secret env for `projectPath`, returning `null`
// (not throwing) so a resolve failure degrades to a plain Codex spawn and never
// blocks it. Called by the spawn chokepoint (`resolveHarnessSpawnBody`), which
// ships the result to the terminal-server; the terminal-server injects the
// `--config` args + pty env (no policy resolution there). See mcp/CLAUDE.md.
export async function resolveManagedCodexServers(
  projectPath: string,
  ctx: McpResolveContext = {},
  preloadedSettings?: ResolveSettings,
): Promise<CodexMcpResolution | null> {
  try {
    const [catalog, settings, secrets] = await loadResolveInputs(projectPath, preloadedSettings);
    return resolveCodexServers(catalog, settings, secrets, withSpawnContext(projectPath, ctx));
  } catch (err) {
    console.warn(
      `[mcp] codex resolve failed for ${projectPath}: ${(err as Error).message}`,
    );
    return null;
  }
}

// Best-effort Pi analogue: resolve the enabled Pi server map + secret env for
// `projectPath`, returning `null` (not throwing) so a resolve failure degrades
// to a plain Pi spawn. Called by the Pi spawn chokepoint (`applyPiMcpForSpawn`),
// which writes `<cwd>/.pi/mcp.json` + the extension shim and ships the secret
// env to the pty. See mcp/CLAUDE.md.
export async function resolveManagedPiServers(
  projectPath: string,
  ctx: McpResolveContext = {},
  preloadedSettings?: ResolveSettings,
): Promise<PiMcpResolution | null> {
  try {
    const [catalog, settings, secrets] = await loadResolveInputs(projectPath, preloadedSettings);
    return resolvePiServers(catalog, settings, secrets, withSpawnContext(projectPath, ctx));
  } catch (err) {
    console.warn(
      `[mcp] pi resolve failed for ${projectPath}: ${(err as Error).message}`,
    );
    return null;
  }
}
