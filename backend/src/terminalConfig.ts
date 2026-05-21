// Rolling terminal replay buffer cap. The name is historical: terminal output
// is tracked using JavaScript string length to preserve existing behavior.
export const TERMINAL_CONFIG = {
  BUFFER_REPLAY_MAX_BYTES: 200_000,
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
