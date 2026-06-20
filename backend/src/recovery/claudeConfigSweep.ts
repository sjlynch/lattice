import {
  pruneStaleClaudeProjectEntries,
  sweepOrphanedClaudeConfigTemps,
} from '../claudeTrust.js';

// Boot-time reclamation of dead `projects[<path>]` entries in `~/.claude.json`
// that point at Lattice ephemeral worktree/scratch cwds removed on a prior run.
//
// Every Lattice spawn pre-seeds a `projects[<cwd>]` entry (workspace trust + the
// managed MCP set) keyed by a throwaway cwd — a worktree checkout or a push / QA
// / post-merge / workflow-step scratch dir. Nothing ever removed those entries,
// so the map grew unbounded (one dead entry per task/run) and Claude re-parses
// the whole file on every launch. This mirrors the worktree / push / QA scratch
// sweeps: at boot, an ephemeral cwd that no longer exists on disk is by
// definition leftover, so its entry is safe to drop.
//
// GLOBAL (not per-project): `~/.claude.json` is one shared file keyed by absolute
// cwd, so a single pass covers every project's accumulated entries at once.
// Runs AFTER the worktree / push / QA dir sweeps so entries for dirs those just
// reclaimed are pruned in the same boot.
export async function sweepStaleClaudeProjectEntries(): Promise<void> {
  const removed = await pruneStaleClaudeProjectEntries();
  if (removed > 0) {
    console.log(
      `[startup] claude.json sweep: removed ${removed} stale Lattice ephemeral ` +
        `project ${removed === 1 ? 'entry' : 'entries'} from ~/.claude.json`,
    );
  }
}

// Boot-time reclamation of orphaned `~/.claude.json.lattice-*.tmp` (and the
// analogous mcpSecrets temps) left when a writer was hard-killed between the
// temp write and the rename. These accumulated unbounded (one realistic pile
// hit ~8MB) because the atomic-write path used to neither clean up on a failed
// rename nor have a sweep. Skips temps newer than 60s so a live terminal-
// server's in-flight write is never touched. GLOBAL (one shared home dir).
export async function sweepOrphanedClaudeConfigTempFiles(): Promise<void> {
  const removed = await sweepOrphanedClaudeConfigTemps();
  if (removed > 0) {
    console.log(
      `[startup] claude.json sweep: removed ${removed} orphaned ` +
        `${removed === 1 ? 'temp file' : 'temp files'} (~/.claude.json.lattice-*.tmp)`,
    );
  }
}
