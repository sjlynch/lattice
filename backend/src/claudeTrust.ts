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
//
// This module also owns the low-level `~/.claude.json` PRIMITIVES shared with
// claudeConfigGuard.ts: the mkdir mutex, the atomic temp→rename writer (with
// temp-cleanup-on-failure + a short retry through Windows file-locks), the
// restore-from-backup path, and the orphan-temp sweep. Critically, the per-
// spawn read (`readClaudeConfig`) HEALS a corrupt `~/.claude.json` from the
// known-good backup instead of bailing — Claude rewrites this file in-place on
// shutdown and a Lattice force-kill mid-write truncates it, so without healing
// the next agent to spawn here would read the truncated file and show a
// blocking "invalid JSON" prompt. Healing at this chokepoint (microseconds
// before `pty.spawn`) repairs it before that read. claudeConfigGuard.ts is the
// slower boot/periodic/post-kill backstop layered on the same primitives.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  MANAGED_MCP_MARKER,
  reconcileMcpServers,
  type ClaudeMcpServerConfig,
} from './mcp/claudeInject.js';

export const CLAUDE_GLOBAL_CONFIG = path.join(os.homedir(), '.claude.json');
// Known-good copy maintained by claudeConfigGuard. Owned here (not in the
// guard) because the per-spawn heal-on-read path below also restores from it,
// so the path + restore logic live with the rest of the ~/.claude.json
// primitives and the guard becomes a thin policy layer over them.
export const CLAUDE_JSON_BACKUP = path.join(os.homedir(), '.lattice', 'claude-json-backup.json');
const LOCK_DIR = path.join(os.homedir(), '.claude.json.lattice-lock');
const LOCK_RETRY_DELAYS_MS = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];
// `fs.rename` over an existing ~/.claude.json throws EPERM/EBUSY/EACCES on
// Windows whenever another Claude has the file briefly open (read at startup,
// rewrite at shutdown). With many concurrent agents this collision is routine,
// and it used to (a) leak the temp and (b) silently drop the trust/MCP seed.
// A short bounded retry lets the write land once the other handle closes.
const RENAME_RETRY_DELAYS_MS = [15, 30, 60, 120, 250];
// Prefix every Lattice-written temp shares, so a boot sweep can recognize
// orphans regardless of which file (config or secrets) produced them.
const TEMP_SUFFIX = '.tmp';
function tempPrefix(file: string): string {
  return `${path.basename(file)}.lattice-`;
}

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

// Mirrors projectPath.ts `latticeHomeDir()`, inlined (forward-slashed,
// lowercased) so this module's import surface stays unchanged — it's in the
// terminal-server's fingerprint set, so we avoid pulling extra deps into the
// detached executor's import graph.
function latticeHomeMatchRoot(): string {
  return path.join(os.homedir(), '.lattice').replace(/\\/g, '/').toLowerCase();
}

// True when a `~/.claude.json` projects-map key points at a Lattice-managed
// EPHEMERAL spawn cwd — a per-task worktree checkout or a push / QA / post-merge
// / workflow-step scratch dir. The home-scoped ones all live under `~/.lattice/`;
// legacy (pre-2026-05-10) worktrees were nested at `<repo>/.lattice/worktrees/`.
// Lattice pre-seeds a `projects[<cwd>]` entry for each such cwd at spawn (trust +
// managed MCP), so this identifies the entries safe to reclaim once the dir is
// gone. It deliberately does NOT match a real project root (e.g. the user's repo,
// written by the project-instrumentation reconcile) or the user's own hand-added
// entries — those never live under these paths.
export function isLatticeEphemeralProjectKey(key: string): boolean {
  const norm = key.replace(/\\/g, '/').toLowerCase();
  const home = latticeHomeMatchRoot();
  // `home + '/'` (not bare `home`) so a sibling like `~/.lattice-backups` and
  // the `~/.lattice` root itself don't match — only paths strictly under it.
  if (norm.startsWith(home + '/')) return true; // ~/.lattice/{worktrees,per-project/...}
  if (norm.includes('/.lattice/worktrees/')) return true; // legacy in-repo worktrees
  return false;
}

// Pure selection step (filesystem injected) behind `pruneStaleClaudeProjectEntries`:
// of the given project keys, return the Lattice-ephemeral ones whose directory no
// longer exists. A still-live session's cwd exists on disk, so it's kept.
export async function selectStaleEphemeralProjectKeys(
  projectKeys: string[],
  dirExists: (p: string) => Promise<boolean>,
): Promise<string[]> {
  const stale: string[] = [];
  for (const key of projectKeys) {
    if (!isLatticeEphemeralProjectKey(key)) continue;
    if (await dirExists(key)) continue;
    stale.push(key);
  }
  return stale;
}

// Reclaim dead `projects[<path>]` entries from `~/.claude.json` whose key is a
// Lattice ephemeral worktree/scratch cwd that no longer exists on disk.
//
// Every Lattice spawn pre-seeds `projects[<cwd>]` (workspace trust + the managed
// MCP set) for a throwaway cwd — a worktree checkout or push / QA / post-merge /
// workflow-step scratch dir. Those dirs are deleted when the task/run finishes,
// but nothing ever removed the matching project entry, so the map grew by one
// dead entry per run forever — and Claude re-parses the whole file on every
// launch. This is the missing reclamation step (the analogue of the worktree /
// push / QA scratch sweeps), run at boot.
//
// Gate: key is a Lattice ephemeral path AND its directory is gone. The
// read-modify-write goes through the same mkdir mutex as
// `applyClaudeProjectConfig`, so it can't race a concurrent spawn-time write.
// Best-effort: returns the count removed; logs and returns 0 on error.
export async function pruneStaleClaudeProjectEntries(): Promise<number> {
  try {
    return await withClaudeConfigLock(async () => {
      const cfg = await readClaudeConfig();
      const projects = cfg.projects;
      if (!projects) return 0;
      const stale = await selectStaleEphemeralProjectKeys(
        Object.keys(projects),
        pathExists,
      );
      if (stale.length === 0) return 0;
      for (const key of stale) delete projects[key];
      await writeClaudeConfigAtomic(cfg);
      return stale.length;
    });
  } catch (err) {
    console.warn(
      `[claudeTrust] could not prune stale project entries from ~/.claude.json: ${(err as Error).message}`,
    );
    return 0;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Claude stores project keys with forward slashes even on Windows
// (e.g. "C:/development/lattice"), so normalize before lookup/write.
function toClaudeProjectKey(dirPath: string): string {
  return path.resolve(dirPath).replace(/\\/g, '/');
}

// Read + parse ~/.claude.json, HEALING from the known-good backup if the file
// is corrupt. Claude rewrites this file in-place (non-atomically) on shutdown;
// a Lattice force-kill landing mid-write truncates it, and the next Claude to
// read it shows a blocking "invalid JSON" prompt. This is the per-spawn
// chokepoint (callers run microseconds before `pty.spawn`), so healing here —
// instead of bailing on the parse error as we used to — repairs the file
// before the about-to-spawn Claude reads it. MUST be called inside
// `withClaudeConfigLock` (both callers do): the heal writes the file.
async function readClaudeConfig(): Promise<ClaudeGlobalConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  try {
    return JSON.parse(raw) as ClaudeGlobalConfig;
  } catch (parseErr) {
    const restored = await restoreClaudeConfigFromBackupLocked();
    if (restored) {
      console.warn(
        `[claudeTrust] healed corrupt ${CLAUDE_GLOBAL_CONFIG} from backup before spawn`,
      );
      return restored;
    }
    // No usable backup — do NOT reset to {} (that would wipe the user's real
    // projects / auth / history). Surface the error so the caller logs and
    // skips its write, leaving the file for the boot-time guard to handle.
    throw parseErr;
  }
}

async function writeClaudeConfigAtomic(cfg: ClaudeGlobalConfig): Promise<void> {
  await atomicWriteFile(CLAUDE_GLOBAL_CONFIG, JSON.stringify(cfg, null, 2));
}

// Generic temp-write → rename for a file under the user's home. Cleans up its
// temp on any failure (the orphan-temp leak that piled up ~8MB of
// `.claude.json.lattice-*.tmp`) and retries the rename through transient
// Windows file-locks. Shared by the config write above and the guard's backup
// refresh so both get the same durability.
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.lattice-${process.pid}-${Date.now()}${TEMP_SUFFIX}`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || i >= RENAME_RETRY_DELAYS_MS.length) throw err;
      await sleep(RENAME_RETRY_DELAYS_MS[i]);
    }
  }
}

// Restore ~/.claude.json from the known-good backup. Assumes the config lock is
// already held (called from `readClaudeConfig`'s heal path). Returns the parsed
// config on success, or null when the backup is missing or itself unparseable
// (in which case the caller must not destroy the live file).
async function restoreClaudeConfigFromBackupLocked(): Promise<ClaudeGlobalConfig | null> {
  let backupRaw: string;
  try {
    backupRaw = await fs.readFile(CLAUDE_JSON_BACKUP, 'utf8');
  } catch {
    return null;
  }
  let cfg: ClaudeGlobalConfig;
  try {
    cfg = JSON.parse(backupRaw) as ClaudeGlobalConfig;
  } catch {
    return null;
  }
  await atomicWriteFile(CLAUDE_GLOBAL_CONFIG, backupRaw);
  return cfg;
}

// Lock-acquiring wrapper for the guard (claudeConfigGuard.ts), which is not
// otherwise holding the config lock. Returns true when a restore happened.
export async function restoreClaudeConfigFromBackup(): Promise<boolean> {
  return withClaudeConfigLock(
    async () => (await restoreClaudeConfigFromBackupLocked()) !== null,
  );
}

// Boot-time reclamation of orphaned `<file>.lattice-<pid>-<ts>.tmp` temps left
// when a process was hard-killed between the temp write and the rename (or, pre-
// fix, when a rename failed without cleanup). Bounded to the two files Lattice
// writes this way (~/.claude.json and ~/.lattice/mcpSecrets.json) and to temps
// older than `minAgeMs` so an in-flight write by the live terminal-server is
// never touched. Returns the count removed.
export async function sweepOrphanedClaudeConfigTemps(
  minAgeMs = 60_000,
): Promise<number> {
  const targets = [CLAUDE_GLOBAL_CONFIG, CLAUDE_JSON_BACKUP, mcpSecretsFile()];
  const now = Date.now();
  let removed = 0;
  for (const file of targets) {
    const dir = path.dirname(file);
    const prefix = tempPrefix(file);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fs.stat(full);
        if (now - st.mtimeMs < minAgeMs) continue; // possibly an in-flight write
        await fs.unlink(full);
        removed += 1;
      } catch {
        /* raced with another sweep / gone already — fine */
      }
    }
  }
  return removed;
}

function mcpSecretsFile(): string {
  return path.join(os.homedir(), '.lattice', 'mcpSecrets.json');
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
