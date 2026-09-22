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
import { canonicalProjectPath } from '../projectPath.js';
import { getBackendServerConfig } from '../server/config.js';
import { readMcpSecrets, type McpSecrets } from './secrets.js';
import {
  BUILTIN_MCP_SERVERS,
  LATTICE_MCP_SERVER_ID,
  type McpHarnessSupport,
  type McpServerEntry,
} from './catalog.js';
import { UnsafeCmdArgumentError, type ClaudeMcpServerConfig } from './claudeInject.js';
import { resolvePlaywright } from './resolverPolicy.js';
import { toClaudeConfig } from './claudeServerConfig.js';
import { safeCodexServerId, toCodexServerConfig } from './codexServerConfig.js';
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
// spawned. `isQaRun` gates the QA-scoped Playwright (see `resolvePlaywright` in
// `resolverPolicy.ts`); `projectPath`/`apiUrl` are what the first-party
// `lattice` server needs baked into its per-spawn env.
export type McpResolveContext = {
  // True ONLY for the QA-lane "run an e2e test" sessions. Gates the QA-scoped
  // Playwright enablement (`qaPlaywright`), which must NOT leak into ordinary
  // task / sidebar / push / workflow sessions — those get Playwright only via
  // the global `mcpOverrides.playwright` toggle.
  isQaRun?: boolean;
  // The project this session belongs to. The `lattice` server is pinned to ONE
  // board, so without this there is nothing for it to serve and it is dropped
  // from the resolved set entirely.
  projectPath?: string;
  // Backend origin the `lattice` server should call (`http://127.0.0.1:<port>`).
  // Passed in by the async resolvers so the pure core does no config lookup of
  // its own; a hand-built ctx that omits it falls back to the same value.
  apiUrl?: string;
  // The task whose worktree this session is — set ONLY by the task run/resume
  // spawns. Baked into the `lattice` server's env as `LATTICE_TASK_ID` so the
  // worktree agent gets a `my_task` tool and an id-less `append_summary`.
  // Absent for every other spawn (sidebar, workflow step, push, QA, hooks).
  taskId?: string;
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
// map; codex/pi read the nested `mcpHarnessOverrides[harness]` map.
//
// An EXPLICIT boolean always wins — that is what makes `mcpOverrides.lattice =
// false` (or `mcpHarnessOverrides.codex.lattice = false`) a real per-harness
// opt-out rather than a value the default overwrites. With no override the
// answer is the entry's `defaultEnabled`, which is `undefined` on every
// third-party server (so: off, the all-off invariant) and `true` only on
// Lattice's own first-party board server. See catalog.ts.
function harnessToggleOn(
  settings: ResolveSettings,
  harness: AgentHarness,
  entry: McpServerEntry,
): boolean {
  const explicit =
    harness === 'claude'
      ? settings.mcpOverrides?.[entry.id]
      : settings.mcpHarnessOverrides?.[harness]?.[entry.id];
  if (typeof explicit === 'boolean') return explicit;
  return entry.defaultEnabled === true;
}

// Bake the per-spawn env the `lattice` server needs into a CLONE of its catalog
// entry (the catalog itself is shared + long-lived, so it must never be
// mutated). Returns `null` when there is no project to serve: the server pins
// itself to one board and every tool call needs `LATTICE_PROJECT`, so a
// project-less spawn — a sidebar terminal opened before a project is chosen, a
// scratch cwd — is better off with no board tools at all than with eleven that
// all fail on the first call.
function shapeLatticeEntry(
  entry: McpServerEntry,
  ctx: McpResolveContext,
): McpServerEntry | null {
  if (!ctx.projectPath) return null;
  // An override's `env` may TUNE the server but never pre-seed the per-spawn
  // keys: `LATTICE_API_URL`/`LATTICE_PROJECT` are overwritten below anyway, but
  // `LATTICE_TASK_ID` is only SET when the spawn carries a task — so a stray
  // one in the entry env would give every sidebar/workflow/push agent a bogus
  // `my_task`. Strip the whole prefix so the ctx is the only source.
  const baseEnv = Object.fromEntries(
    // Case-insensitive: Windows env is, so a `lattice_task_id` key would reach
    // `process.env.LATTICE_TASK_ID` in the server just the same.
    Object.entries(entry.env ?? {}).filter(([key]) => !/^lattice_/i.test(key)),
  );
  return {
    ...entry,
    env: {
      ...baseEnv,
      LATTICE_API_URL: ctx.apiUrl ?? getBackendServerConfig().backendOrigin,
      // Canonical so the server's own `canonicalProject` assertion against the
      // API envelope is comparing like with like.
      LATTICE_PROJECT: canonicalProjectPath(ctx.projectPath),
      // Only a task-run spawn carries one; the key is omitted (not set empty)
      // otherwise, so the server registers `my_task` exactly when it applies.
      ...(ctx.taskId ? { LATTICE_TASK_ID: ctx.taskId } : {}),
    },
  };
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
        enabled = harnessToggleOn(settings, harness, entry);
        headless = settings.mcpPlaywrightHeaded !== true;
      }
    } else {
      enabled = harnessToggleOn(settings, harness, entry);
    }
    if (!enabled) continue;

    // Lattice's own server is the one entry whose config is not fully static:
    // it carries the project + backend URL for THIS spawn. Shaped into a clone
    // (never a mutation of the shared catalog), and dropped when there is no
    // project to serve.
    let resolvedEntry = entry;
    if (entry.id === LATTICE_MCP_SERVER_ID) {
      const shaped = shapeLatticeEntry(entry, ctx);
      if (!shaped) continue;
      resolvedEntry = shaped;
    }

    // Own-property lookup: an id like `toString` must not resolve an inherited
    // Object member as the server's secret map.
    const serverSecrets = Object.hasOwn(secrets, entry.id) ? secrets[entry.id] : undefined;
    out.push({ entry: resolvedEntry, serverSecrets, headless });
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
    const clash = envNameClash(env, shaped.env);
    if (clash) {
      console.warn(
        `[mcp] codex: skipping server "${entry.id}" — its secret env var ${clash} is already ` +
          'claimed by another server with a different value',
      );
      continue;
    }
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
    const clash = envNameClash(env, shaped.env);
    if (clash) {
      console.warn(
        `[mcp] pi: skipping server "${entry.id}" — its secret env var ${clash} is already ` +
          'claimed by another server with a different value',
      );
      continue;
    }
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
  ctx: McpResolveContext = {},
): Promise<CodexMcpResolution | null> {
  try {
    const [catalog, settings, secrets] = await Promise.all([
      mergedCatalog(),
      getUserSettings(projectPath),
      readMcpSecrets(),
    ]);
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
): Promise<PiMcpResolution | null> {
  try {
    const [catalog, settings, secrets] = await Promise.all([
      mergedCatalog(),
      getUserSettings(projectPath),
      readMcpSecrets(),
    ]);
    return resolvePiServers(catalog, settings, secrets, withSpawnContext(projectPath, ctx));
  } catch (err) {
    console.warn(
      `[mcp] pi resolve failed for ${projectPath}: ${(err as Error).message}`,
    );
    return null;
  }
}
