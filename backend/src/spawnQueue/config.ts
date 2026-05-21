// Spawn-queue tuning. softCap is the real concurrency governor; the
// terminal-server's MAX_TERMINAL_SESSIONS is now only a runaway backstop.
//
// softCap is machine-global (one backend, one terminal-server, one box's
// RAM/CPU) so it is NOT a per-project UserSetting. Phase 1 ships it as a
// constant with an env override; Phase 3 adds ~/.lattice/globalSettings.json
// + a SettingsDialog control.

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const SPAWN_QUEUE_CONFIG = {
  // Max agents Lattice will run concurrently. 24 is a sustainable default —
  // the resource incident that motivated the queue pegged CPU at ~50 live
  // agents. The queue makes this a throughput knob, not a ceiling on total
  // queued work: excess spawns wait, they are never dropped. Power users on
  // beefier machines raise it via LATTICE_MAX_CONCURRENT_AGENTS.
  softCap: readPositiveInt(process.env.LATTICE_MAX_CONCURRENT_AGENTS, 24),
  // Extra slots above softCap reserved for the `priority`/`interactive`
  // bands (merge-conflict resolvers, post-merge hook, push runs) so a
  // blocking merge run can always make progress even with batch slots full.
  priorityReserve: 6,
  // GET /sessions poll cadence while the queue has pending/reserved work.
  // The poll loop is idle (zero cost) whenever the queue is empty.
  pollIntervalMs: 1_500,
  // Hard timeout on a single /sessions poll request.
  pollTimeoutMs: 3_000,
} as const;
