// Auto-backup + auto-restore for `~/.claude.json`.
//
// Lattice force-kills PTY process trees on session shutdown, worktree
// cleanup, and terminal-server respawn (Windows has no clean alternative
// — pty.kill closes the conpty but Claude, a grandchild, doesn't see it).
// If Claude was mid-write to `~/.claude.json` when killed, the file is
// truncated and Claude refuses to start next time with a "Configuration
// Error: Unterminated string" prompt that blocks the user.
//
// We can't fully prevent that without a graceful-shutdown protocol Claude
// doesn't expose — so we make it self-healing instead. Backup the file
// while it's valid; restore from backup when we observe corruption.
//
// This module is the POLICY layer (when to back up, when to restore, the
// read-twice debounce). The actual file primitives — the backup path, the
// mkdir-mutex-serialized atomic write, and the restore — live in
// `claudeTrust.ts` alongside the per-spawn writer, so the guard here and the
// per-spawn heal-on-read path share one lock and one atomic-write
// implementation. The per-spawn path (`applyClaudeProjectConfig` →
// `readClaudeConfig`) is what actually closes the corruption-reaches-a-fresh-
// spawn window; this guard is the slower boot/periodic/post-kill backstop and
// the thing that keeps the known-good backup current.

import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_GLOBAL_CONFIG as CLAUDE_JSON,
  CLAUDE_JSON_BACKUP as BACKUP,
  atomicWriteFile,
  restoreClaudeConfigFromBackup,
} from './claudeTrust.js';

// Settle delay between the two reads in `validate` — long enough to let an
// in-flight Claude write finish, short enough not to stall a health tick.
const REVALIDATE_DELAY_MS = 200;

function tryRead(): { ok: true; content: string } | { ok: false } {
  try {
    const content = fs.readFileSync(CLAUDE_JSON, 'utf8');
    JSON.parse(content);
    return { ok: true, content };
  } catch {
    return { ok: false };
  }
}

// Read-twice with a small delay: distinguishes a momentary mid-write
// (Claude is alive and just hasn't flushed yet) from genuine post-kill
// corruption. Without this, a 60 s health-tick can trip on an in-flight
// write and "restore" over a perfectly healthy file Claude was about
// to finish.
async function validate(): Promise<{ valid: boolean; content?: string }> {
  const first = tryRead();
  if (first.ok) return { valid: true, content: first.content };
  await new Promise<void>((r) => setTimeout(r, REVALIDATE_DELAY_MS));
  const second = tryRead();
  if (second.ok) return { valid: true, content: second.content };
  return { valid: false };
}

type Opts = {
  // Refresh the on-disk backup with the current valid content. Skip this
  // (the default for post-kill checks) when we're not sure whether
  // Claude finished writing — we'd rather keep an older known-good
  // backup than overwrite it with the tail of a write we just aborted.
  refreshBackup?: boolean;
};

export async function ensureClaudeConfigValid(opts: Opts = {}): Promise<void> {
  if (!fs.existsSync(CLAUDE_JSON)) return; // nothing to guard yet
  const { valid, content } = await validate();
  if (valid) {
    if (opts.refreshBackup && content) {
      try {
        await fs.promises.mkdir(path.dirname(BACKUP), { recursive: true });
        await atomicWriteFile(BACKUP, content);
      } catch {
        /* best effort — corrupt-disk write failures shouldn't block startup */
      }
    }
    return;
  }
  try {
    const restored = await restoreClaudeConfigFromBackup();
    if (restored) {
      console.warn(`[lattice] restored corrupt ${CLAUDE_JSON} from ${BACKUP}`);
    } else {
      console.warn(
        `[lattice] ${CLAUDE_JSON} appears corrupt and no usable backup is available — Claude may prompt the user to reset it`,
      );
    }
  } catch (err) {
    console.warn(
      `[lattice] failed to restore ${CLAUDE_JSON} from backup: ${(err as Error).message}`,
    );
  }
}
