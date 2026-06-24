// Low-level `~/.claude.json` PRIMITIVES: parse-on-read with heal-from-backup,
// the atomic temp→rename writer (temp-cleanup-on-failure + a short retry through
// Windows file-locks), and the restore-from-backup path. Shared by the per-spawn
// apply path (apply.ts), the maintenance sweeps (maintenance.ts), and the slower
// boot/periodic guard (../claudeConfigGuard.ts) so all four use one writer.
//
// Critically, the per-spawn read (`readClaudeConfig`) HEALS a corrupt
// `~/.claude.json` from the known-good backup instead of bailing: Claude
// rewrites this file in-place (non-atomically) on shutdown, and a Lattice
// force-kill landing mid-write truncates it, so without healing the next agent
// to spawn here would read the truncated file and show a blocking "invalid JSON"
// prompt. Healing at this chokepoint (microseconds before `pty.spawn`) repairs
// it before that read. The writes here MUST run inside `withClaudeConfigLock`.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { withClaudeConfigLock } from './configLock.js';
import { sleep, unlinkQuietly } from './util.js';

export const CLAUDE_GLOBAL_CONFIG = path.join(os.homedir(), '.claude.json');
// Known-good copy maintained by claudeConfigGuard. The path + restore logic
// live here (not in the guard) because the per-spawn heal-on-read path below
// also restores from it, so they sit with the rest of the ~/.claude.json
// primitives and the guard becomes a thin policy layer over them.
export const CLAUDE_JSON_BACKUP = path.join(os.homedir(), '.lattice', 'claude-json-backup.json');

// `fs.rename` over an existing ~/.claude.json throws EPERM/EBUSY/EACCES on
// Windows whenever another Claude has the file briefly open (read at startup,
// rewrite at shutdown). With many concurrent agents this collision is routine,
// and it used to (a) leak the temp and (b) silently drop the trust/MCP seed.
// A short bounded retry lets the write land once the other handle closes.
const RENAME_RETRY_DELAYS_MS = [15, 30, 60, 120, 250];
// Suffix on every Lattice-written temp, so a boot sweep can recognize orphans
// regardless of which file (config or secrets) produced them.
export const TEMP_SUFFIX = '.tmp';
// Per-file prefix component of a Lattice temp name (`<basename>.lattice-`).
// Shared by the writer (below) and the orphan-temp sweep (maintenance.ts).
export function tempPrefix(file: string): string {
  return `${path.basename(file)}.lattice-`;
}

export type ClaudeProjectEntry = {
  hasTrustDialogAccepted?: boolean;
  allowedTools?: unknown[];
  mcpContextUris?: unknown[];
  mcpServers?: Record<string, unknown>;
  enabledMcpjsonServers?: unknown[];
  disabledMcpjsonServers?: unknown[];
  [k: string]: unknown;
};

export type ClaudeGlobalConfig = {
  projects?: Record<string, ClaudeProjectEntry>;
  [k: string]: unknown;
};

// Claude stores project keys with forward slashes even on Windows
// (e.g. "C:/development/lattice"), so normalize before lookup/write.
export function toClaudeProjectKey(dirPath: string): string {
  return path.resolve(dirPath).replace(/\\/g, '/');
}

// Read + parse ~/.claude.json, HEALING from the known-good backup if the file
// is corrupt. Claude rewrites this file in-place (non-atomically) on shutdown;
// a Lattice force-kill landing mid-write truncates it, and the next Claude to
// read it shows a blocking "invalid JSON" prompt. This is the per-spawn
// chokepoint (callers run microseconds before `pty.spawn`), so healing here —
// instead of bailing on the parse error as we used to — repairs the file
// before the about-to-spawn Claude reads it. MUST be called inside
// `withClaudeConfigLock` (all callers do): the heal writes the file.
export async function readClaudeConfig(): Promise<ClaudeGlobalConfig> {
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

export async function writeClaudeConfigAtomic(cfg: ClaudeGlobalConfig): Promise<void> {
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
    await unlinkQuietly(tmp);
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
