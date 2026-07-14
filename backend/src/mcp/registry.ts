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
import { toCodexServerConfig } from './codexServerConfig.js';
import { toPiServerConfig, type PiMcpServerConfig } from './piServerConfig.js';
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

// The per-project settings the resolver reads. `mcpOverrides` is CLAUDE's map
// (plus the Playwright global toggle); `mcpHarnessOverrides` is the nested
// codex/pi map; `qaPlaywright` is the Claude-only QA scope.
type ResolveSettings = Pick<
  UserSettings,
  'mcpOverrides' | 'qaPlaywright' | 'mcpHarnessOverrides' | 'mcpPlaywrightHeaded'
>;

// One entry that survived the enable + harness-support filter, paired with the
// data a per-harness shaper needs (its stored secrets + the computed Playwright
// headless flag). This is the harness-NEUTRAL core the three shapers share.
export type ResolvedMcpEntry = {
  entry: McpServerEntry;
  serverSecrets: Record<string, string> | undefined;
  // Meaningful only for the Playwright entry (see resolvePlaywright).
  headless: boolean;
};

// Is this server toggled on for `harness`? Claude reads the legacy `mcpOverrides`
// map; codex/pi read the nested `mcpHarnessOverrides[harness]` map. Default OFF
// everywhere (the all-off invariant).
function harnessToggleOn(
  settings: ResolveSettings,
  harness: AgentHarness,
  id: string,
): boolean {
  if (harness === 'claude') return settings.mcpOverrides?.[id] === true;
  return settings.mcpHarnessOverrides?.[harness]?.[id] === true;
}

// The PURE, harness-neutral resolver core: given the loaded catalog, project
// settings, secrets, target harness, and spawn context, decide the enabled
// entry set. No I/O — this is the unit of logic worth testing exhaustively
// (all-off default, per-harness independence, global vs QA-only Playwright +
// headless flag, harnessSupport filter, custom merge). The three per-harness
// shapers (`resolveClaudeServers` / `resolveCodexServers` / `resolvePiServers`)
// map this into their own config shapes.
export function resolveMcpEntries(
  catalog: McpServerEntry[],
  settings: ResolveSettings,
  secrets: McpSecrets,
  harness: AgentHarness,
  ctx: McpResolveContext = {},
): ResolvedMcpEntry[] {
  const isQaRun = ctx.isQaRun === true;
  const out: ResolvedMcpEntry[] = [];
  for (const entry of catalog) {
    if (!harnessSupports(entry.harnessSupport, harness)) continue;
    let enabled = false;
    let headless = false;
    if (entry.id === 'playwright') {
      if (harness === 'claude') {
        // Claude Playwright has two scopes (global vs QA-only) + a computed
        // headless flag, so it doesn't go through the plain toggle gate.
        const pw = resolvePlaywright(settings, isQaRun);
        enabled = pw.enabled;
        headless = pw.headless;
      } else {
        // codex/pi: a plain per-harness toggle (no QA scope — the QA runner
        // stays Claude-only; see the plan D7). Headless unless the MCP-tab
        // "headed" toggle is on — the same `mcpPlaywrightHeaded` opt-in Claude's
        // global toggle honors, so "watch the browser" works across all harnesses.
        enabled = harnessToggleOn(settings, harness, entry.id);
        headless = settings.mcpPlaywrightHeaded !== true;
      }
    } else {
      enabled = harnessToggleOn(settings, harness, entry.id);
    }
    if (!enabled) continue;
    out.push({ entry, serverSecrets: secrets[entry.id], headless });
  }
  return out;
}

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
    out[entry.id] = toClaudeConfig(entry, serverSecrets, headless);
  }
  return out;
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
): CodexMcpResolution {
  const configArgs: string[] = [];
  const env: Record<string, string> = {};
  for (const { entry, serverSecrets, headless } of resolveMcpEntries(
    catalog,
    settings,
    secrets,
    'codex',
    {},
  )) {
    const shaped = toCodexServerConfig(entry, serverSecrets, headless);
    configArgs.push(shaped.configArg);
    Object.assign(env, shaped.env);
  }
  return { configArgs, env };
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
): PiMcpResolution {
  const mcpServers: Record<string, PiMcpServerConfig> = {};
  const env: Record<string, string> = {};
  for (const { entry, serverSecrets, headless } of resolveMcpEntries(
    catalog,
    settings,
    secrets,
    'pi',
    {},
  )) {
    const shaped = toPiServerConfig(entry, serverSecrets, headless);
    mcpServers[entry.id] = shaped.config;
    Object.assign(env, shaped.env);
  }
  return { mcpServers, env };
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
): Promise<Record<string, ClaudeMcpServerConfig>> {
  // This resolver returns CLAUDE's config shape; other harnesses shape
  // differently and go through their own resolver.
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

// Best-effort Codex analogue of `resolveManagedClaudeServers`: resolve the
// enabled Codex `-c` overrides + secret env for `projectPath`, returning `null`
// (not throwing) so a resolve failure degrades to a plain Codex spawn and never
// blocks it. Called by the spawn chokepoint (`resolveHarnessSpawnBody`), which
// ships the result to the terminal-server; the terminal-server injects the
// `--config` args + pty env (no policy resolution there). See mcp/CLAUDE.md.
export async function resolveManagedCodexServers(
  projectPath: string,
): Promise<CodexMcpResolution | null> {
  try {
    const [catalog, settings, secrets] = await Promise.all([
      mergedCatalog(),
      getUserSettings(projectPath),
      readMcpSecrets(),
    ]);
    return resolveCodexServers(catalog, settings, secrets);
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
): Promise<PiMcpResolution | null> {
  try {
    const [catalog, settings, secrets] = await Promise.all([
      mergedCatalog(),
      getUserSettings(projectPath),
      readMcpSecrets(),
    ]);
    return resolvePiServers(catalog, settings, secrets);
  } catch (err) {
    console.warn(
      `[mcp] pi resolve failed for ${projectPath}: ${(err as Error).message}`,
    );
    return null;
  }
}
