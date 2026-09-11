// The public APPLY mechanism: write a pre-resolved set of managed MCP servers
// (or `null` for a trust-only seed) into `~/.claude.json`'s `projects[<dir>]`.
//
// This is the APPLY mechanism ONLY. It deliberately does NOT resolve policy
// (which servers, headed/headless, the memory opt-out): that lives in the main
// backend (`mcp/registry.ts` + `terminalServerClient.ts`), which passes the
// resolved `managed` set in. Keeping the resolver out of here is what lets the
// detached terminal-server import this path without pulling the whole MCP policy
// chain — so a policy change is a backend-only edit and never forces a
// terminal-server respawn. See ../mcp/CLAUDE.md "Injection sites".
//
// The config mutex only orders writes that overlap in time; it cannot stop the
// slower lost-update where Claude reverts a trust entry it never saw (it reads
// `~/.claude.json` at startup and writes the whole object back at shutdown). So
// a single setup-time seed is not enough — the terminal-server's `POST
// /sessions` handler calls `applyClaudeProjectConfig` again microseconds before
// `pty.spawn` to shrink that clobber window to near zero. The setup-time calls
// stay as an early first layer; the spawn-time call is the one that closes the
// race. See ../claudeTrust.ts and configLock.ts.
import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  MANAGED_MCP_MARKER,
  reconcileMcpServers,
  type ClaudeMcpServerConfig,
} from '../mcp/claudeInject.js';
import { withClaudeConfigLock } from './configLock.js';
import {
  CLAUDE_GLOBAL_CONFIG,
  readClaudeConfig,
  writeClaudeConfigAtomic,
  toClaudeProjectKey,
  type ClaudeGlobalConfig,
  type ClaudeProjectEntry,
} from './configFile.js';

function alreadyApplied(
  cfg: ClaudeGlobalConfig,
  key: string,
  managed: Record<string, ClaudeMcpServerConfig> | null,
): boolean {
  const existing = cfg?.projects?.[key];
  if (existing?.hasTrustDialogAccepted !== true) return false;
  if (managed === null) return true;
  const prevManaged = existing[MANAGED_MCP_MARKER];
  if (Object.keys(managed).length === 0 && !(Array.isArray(prevManaged) && prevManaged.length)) return true;
  // Reconciliation replaces the shallow clone's MCP map and marker; it does
  // not mutate the existing entry or its server configurations.
  const candidate = { ...existing };
  reconcileMcpServers(candidate, managed);
  return isDeepStrictEqual(candidate, existing);
}

// Apply a pre-resolved Claude project config to `~/.claude.json`'s
// `projects[<dirPath>]`: pre-accept workspace trust and reconcile the given
// `managed` MCP server set into it. `managed === null` is a trust-ONLY seed
// (the historical behavior) — it never touches `mcpServers`, so it can't strip
// MCP a prior call added. A non-null `managed` (possibly `{}`) reconciles:
// adds/updates Lattice-managed servers and strips previously-managed-now-absent
// ones, leaving the user's own entries alone (the `__latticeManagedMcp` marker).
//
// Callers:
//   - terminal-server `POST /sessions` — the per-spawn chokepoint, microseconds
//     before `pty.spawn`, with the `managed` set the backend resolved and sent.
//   - project-instrumentation route — `dirPath === <projectRoot>` to reconcile
//     the GLOBAL servers into the user's own project-root entry.
//   - `seedClaudeTrust` — the trust-only setup seeds (worktree/scratch dirs).
export async function applyClaudeProjectConfig(
  dirPath: string,
  { managed }: { managed: Record<string, ClaudeMcpServerConfig> | null },
): Promise<void> {
  const key = toClaudeProjectKey(dirPath);
  try {
    // A read-only no-op does not need a mutex or a writable lock location.
    // In particular, opening an already-configured project should not fail
    // just because Windows briefly denies creating Lattice's lock. Never heal
    // here, and never use this optimistic snapshot for a subsequent write.
    try {
      const current = JSON.parse(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8')) as ClaudeGlobalConfig;
      if (alreadyApplied(current, key, managed)) return;
    } catch {
      // Missing, unreadable or corrupt config goes through the normal locked
      // path below, including its existing backup recovery and diagnostics.
    }
    await withClaudeConfigLock(async () => {
      const cfg = await readClaudeConfig();
      if (alreadyApplied(cfg, key, managed)) return;
      const projects = (cfg.projects ??= {});
      const existing = projects[key];
      // Mirror the structural empty-collection fields Claude writes on first
      // accept so any later code that introspects the entry doesn't trip on
      // missing fields. Spread `existing` last so we never clobber data Claude
      // wrote (e.g. lastCost on a re-seed of an already-known path).
      const entry: ClaudeProjectEntry = {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        ...existing,
        hasTrustDialogAccepted: true,
      };
      if (managed !== null) reconcileMcpServers(entry, managed);
      projects[key] = entry;
      await writeClaudeConfigAtomic(cfg);
    });
  } catch (err) {
    const detail = err instanceof SyntaxError
      ? 'Claude config contains invalid JSON and could not be restored from a usable backup'
      : (err as Error).message;
    console.warn(
      `[claudeTrust] could not apply Claude config for ${dirPath}: ${detail}. ` +
        'Claude may show the trust dialog on first launch; Lattice-managed MCP settings may also be out of date.',
    );
  }
}

// Trust-only seed for a brand-new Lattice scratch/worktree dir (no MCP
// reconcile). Used by setup-time seeds (worktree files, push / QA / post-merge
// scratch) so the very first launch doesn't stall on the trust dialog.
export async function seedClaudeTrust(dirPath: string): Promise<void> {
  await applyClaudeProjectConfig(dirPath, { managed: null });
}
