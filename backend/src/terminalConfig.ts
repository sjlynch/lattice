// Terminal-session tunables shared by the detached terminal-server.
export const TERMINAL_CONFIG = {
  // How much scrollback we replay to a (re)attaching client. The history is
  // persisted to a per-session on-disk log (see terminal/scrollbackStore.ts),
  // so this window can be large without holding it all in memory. Replaces
  // the old in-memory-only ~200 KB rolling buffer, whose cap meant a page
  // reload / project switch / backend-restart reattach lost almost all
  // history (and for a full-screen TUI, 200 KB of raw redraw bytes was only
  // a few screens). Measured in bytes of raw pty output.
  SCROLLBACK_REPLAY_BYTES: 2_000_000,
  // In-memory pending output before it is flushed to the on-disk log. Bounds
  // per-session memory; the hot pty.onData path only pays a disk write once
  // per this many bytes.
  SCROLLBACK_FLUSH_BYTES: 64_000,
  // On-disk log ceiling. When the log grows past this it is compacted down to
  // SCROLLBACK_KEEP_BYTES (keep the most recent tail), so a long-lived noisy
  // terminal can't grow its log without bound. KEEP must be >= REPLAY so a
  // replay right after a compaction still has the full window available.
  SCROLLBACK_MAX_DISK_BYTES: 8_000_000,
  SCROLLBACK_KEEP_BYTES: 4_000_000,
  INITIAL_COMMAND_WRITE_DELAY_MS: 250,
  // Hard ceiling on simultaneously-live ptys — a pure runaway backstop, NOT
  // the real concurrency governor. That role now belongs to the spawn
  // queue's softCap (spawnQueue/config.ts, default 24, env-overridable):
  // spawns above softCap are deferred in a durable queue, never dropped.
  // This cap only exists to catch a genuine runaway (a stuck frontend
  // reconnect loop, an accounting bug) before it can exhaust memory on
  // Windows. Sized well above softCap + PRIORITY_RESERVE plus headroom for
  // un-queued manual terminals (new-shell tray, startup terminals).
  MAX_TERMINAL_SESSIONS: 200,
} as const;
