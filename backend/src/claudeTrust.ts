// Pre-seed Claude Code's "trust this folder" dialog for fresh Lattice-created
// directories. Without this, every new push-scratch and home-scoped worktree
// dir prompts the user on first spawn, because trust is per-project-root and
// those dirs are brand new each time.
//
// `--dangerously-skip-permissions` does NOT cover this — the trust gate runs
// before any settings load and has no documented CLI/env/settings.json knob
// (anthropics/claude-code#28506, #29285). Trust state is persisted in
// `~/.claude.json` under `projects.<forward-slash-abs-path>.hasTrustDialogAccepted`,
// which Claude writes itself on accept; pre-writing it skips the prompt.
// We depend on an undocumented internal key — if Anthropic renames it the
// dialog will come back (not destructive, just annoying).
//
// Read-mutate-write is serialized through a mkdir-based mutex because Claude
// itself rewrites this file on shutdown (lastCost, lastSessionId, etc.) and
// we'd otherwise lost-update each other.
//
// The mutex only orders writes that overlap *in time*. It cannot stop the
// slower lost-update: Claude reads `~/.claude.json` once at startup, holds it
// in memory for the whole session, and writes the entire object back on
// shutdown. A trust entry added between that read and that write is silently
// reverted. With many concurrent Lattice agents this happens routinely, so a
// single pre-seed at session-setup time is not enough — a queued spawn can
// sit in the admission queue while other agents exit and clobber it. The
// terminal-server's `POST /sessions` handler therefore calls
// `applyClaudeProjectConfig` again, microseconds before `pty.spawn`, to shrink
// that clobber window to near zero. The setup-time calls stay as an early
// first layer; the spawn-time call is the one that actually closes the race.
//
// This module is the APPLY mechanism only — it writes a pre-resolved set of
// managed MCP servers (or `null` for a trust-only seed) into `~/.claude.json`.
// It deliberately does NOT resolve policy (which servers, headed/headless, the
// memory opt-out): that lives in the main backend (`mcp/registry.ts` +
// `terminalServerClient.ts`), which passes the resolved `managed` set in.
// Keeping the resolver out of this file is what lets the detached terminal-
// server import the apply path without pulling the whole MCP policy chain — so
// a policy change is a backend-only edit and never forces a terminal-server
// respawn. See mcp/CLAUDE.md "Injection sites".
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  MANAGED_MCP_MARKER,
  reconcileMcpServers,
  type ClaudeMcpServerConfig,
} from './mcp/claudeInject.js';

const CLAUDE_GLOBAL_CONFIG = path.join(os.homedir(), '.claude.json');
const LOCK_DIR = path.join(os.homedir(), '.claude.json.lattice-lock');
const LOCK_RETRY_DELAYS_MS = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

type ClaudeProjectEntry = {
  hasTrustDialogAccepted?: boolean;
  allowedTools?: unknown[];
  mcpContextUris?: unknown[];
  mcpServers?: Record<string, unknown>;
  enabledMcpjsonServers?: unknown[];
  disabledMcpjsonServers?: unknown[];
  [k: string]: unknown;
};

type ClaudeGlobalConfig = {
  projects?: Record<string, ClaudeProjectEntry>;
  [k: string]: unknown;
};

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
    await withClaudeConfigLock(async () => {
      const cfg = await readClaudeConfig();
      const projects = (cfg.projects ??= {});
      const existing = projects[key];
      const alreadyTrusted = existing?.hasTrustDialogAccepted === true;
      // Fast-exit when there's nothing to do: already trusted AND the reconcile
      // wouldn't change anything. "No-op reconcile" = a trust-only call
      // (`managed === null`) OR a reconcile that resolves to zero servers AND
      // none were previously managed here (so there's nothing to strip either).
      // This keeps the project-root re-seed a no-op for the common case of a
      // project with no GLOBAL MCP servers, instead of rewriting ~/.claude.json
      // on every project open. When `managed` has entries (or we still need to
      // strip a now-disabled one) we proceed even if already trusted.
      const prevManaged = existing?.[MANAGED_MCP_MARKER];
      const hadManaged = Array.isArray(prevManaged) && prevManaged.length > 0;
      const reconcileIsNoop =
        managed === null || (Object.keys(managed).length === 0 && !hadManaged);
      if (alreadyTrusted && reconcileIsNoop) return;
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
    console.warn(
      `[claudeTrust] could not apply Claude config for ${dirPath}: ${(err as Error).message}. ` +
        `Claude may show the trust dialog on first launch.`,
    );
  }
}

// Trust-only seed for a brand-new Lattice scratch/worktree dir (no MCP
// reconcile). Used by setup-time seeds (worktree files, push / QA / post-merge
// scratch) so the very first launch doesn't stall on the trust dialog.
export async function seedClaudeTrust(dirPath: string): Promise<void> {
  await applyClaudeProjectConfig(dirPath, { managed: null });
}

// Claude stores project keys with forward slashes even on Windows
// (e.g. "C:/development/lattice"), so normalize before lookup/write.
function toClaudeProjectKey(dirPath: string): string {
  return path.resolve(dirPath).replace(/\\/g, '/');
}

async function readClaudeConfig(): Promise<ClaudeGlobalConfig> {
  try {
    const raw = await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8');
    return JSON.parse(raw) as ClaudeGlobalConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

async function writeClaudeConfigAtomic(cfg: ClaudeGlobalConfig): Promise<void> {
  const tmp = `${CLAUDE_GLOBAL_CONFIG}.lattice-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await fs.rename(tmp, CLAUDE_GLOBAL_CONFIG);
}

async function withClaudeConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  for (const delay of [0, ...LOCK_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    try {
      await fs.mkdir(LOCK_DIR);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      continue;
    }
    try {
      return await fn();
    } finally {
      await fs.rmdir(LOCK_DIR).catch(() => {});
    }
  }
  // Lock never acquired (likely stale from a crashed writer). Steal and
  // proceed — trust pre-seed is best-effort and a lost-update here just
  // means the dialog might appear once.
  await fs.rmdir(LOCK_DIR).catch(() => {});
  await fs.mkdir(LOCK_DIR).catch(() => {});
  try {
    return await fn();
  } finally {
    await fs.rmdir(LOCK_DIR).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
