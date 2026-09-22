// Boot-time (and terminal-server timer) reclamation of the cruft Lattice spawns
// leave in / around `~/.claude.json`:
//   - dead `projects[<cwd>]` entries whose key is a Lattice ephemeral
//     worktree/scratch cwd that no longer exists on disk, and
//   - orphaned `<file>.lattice-<pid>-<ts>.tmp` temps left by a writer that was
//     hard-killed between its temp write and the rename.
// Both read-modify-write through the same config mutex as the apply path, so they
// can't race a concurrent spawn-time write.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { withClaudeConfigLock } from './configLock.js';
import {
  CLAUDE_GLOBAL_CONFIG,
  CLAUDE_JSON_BACKUP,
  TEMP_SUFFIX,
  tempPrefix,
  readClaudeConfig,
  writeClaudeConfigAtomic,
} from './configFile.js';

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
// read-modify-write goes through the same config mutex as
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

// Only ENOENT/ENOTDIR prove a cwd is gone. A transient EPERM/EBUSY/EACCES on a
// live worktree used to read as "gone", and the prune then deleted that live
// session's trust + MCP entry out from under it.
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
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
