// The PURE, harness-neutral MCP resolver core: given the loaded catalog,
// project settings, secrets, target harness and spawn context, decide which
// entries are enabled. No I/O beyond the backend-origin fallback in
// `shapeLatticeEntry`. The per-harness shapers (`harnessResolvers.ts`) map the
// result into their own config shapes; `registry.ts` re-exports everything here.

import type { AgentHarness } from '../harnesses.js';
import type { UserSettings } from '../userSettings.js';
import { canonicalProjectPath } from '../projectPath.js';
import { getBackendServerConfig } from '../server/config.js';
import type { McpSecrets } from './secrets.js';
import {
  LATTICE_MCP_SERVER_ID,
  type McpHarnessSupport,
  type McpServerEntry,
} from './catalog.js';
import { resolvePlaywright } from './resolverPolicy.js';

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
  // spawns and the worktree merge-conflict resolvers (manual + merge-run).
  // Baked into the `lattice` server's env as `LATTICE_TASK_ID` so the worktree
  // agent gets a `my_task` tool and an id-less `append_summary` (and loses the
  // board-management tools). Absent for every other spawn (sidebar, workflow
  // step, push, QA, hooks, the project-root stash/snapshot resolvers).
  taskId?: string;
  // Resolve ONLY the first-party `lattice` server (nothing at all when it is
  // toggled off for the harness). Set by the spawn chokepoint for a task
  // worktree session when `taskAgentsLatticeMcpOnly` is on — see
  // `taskWorktreeScope.ts`. Never set for a project-root cwd.
  latticeOnly?: boolean;
};

// The per-project settings the resolver reads. `mcpOverrides` is CLAUDE's map
// (plus the Playwright global toggle); `mcpHarnessOverrides` is the nested
// codex/pi map; `qaPlaywright` is the Claude-only QA scope.
export type ResolveSettings = Pick<
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

// The Playwright entry's enable + headless decision. It doesn't go through the
// plain toggle gate on Claude, which has two scopes (global vs QA-only) + a
// computed headless flag. Codex/pi: a plain per-harness toggle (no QA scope —
// the QA runner stays Claude-only; see the plan D7), headless unless the
// MCP-tab "headed" toggle is on — the same `mcpPlaywrightHeaded` opt-in
// Claude's global toggle honors, so "watch the browser" works across all
// harnesses.
function resolvePlaywrightFor(
  settings: ResolveSettings,
  harness: AgentHarness,
  entry: McpServerEntry,
  isQaRun: boolean,
): { enabled: boolean; headless: boolean } {
  if (harness === 'claude') {
    const pw = resolvePlaywright(settings, isQaRun);
    return { enabled: pw.enabled, headless: pw.headless };
  }
  return {
    enabled: harnessToggleOn(settings, harness, entry),
    headless: settings.mcpPlaywrightHeaded !== true,
  };
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
    // Task-worktree scope: only Lattice's own server survives. Its own toggle
    // still applies below, so an explicit `lattice = false` means zero servers.
    if (ctx.latticeOnly && entry.id !== LATTICE_MCP_SERVER_ID) continue;
    const { enabled, headless } =
      entry.id === 'playwright'
        ? resolvePlaywrightFor(settings, harness, entry, isQaRun)
        : { enabled: harnessToggleOn(settings, harness, entry), headless: false };
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
