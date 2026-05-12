// Rolling terminal replay buffer cap. The name is historical: terminal output
// is tracked using JavaScript string length to preserve existing behavior.
export const TERMINAL_CONFIG = {
  BUFFER_REPLAY_MAX_BYTES: 200_000,
  INITIAL_COMMAND_WRITE_DELAY_MS: 250,
  // Hard ceiling on simultaneously-live ptys. Real Lattice usage tops out
  // around a dozen — anything above that is a runaway loop (e.g. a stuck
  // reconnect on the frontend). This is generous enough to not bite legit
  // power users while catching a runaway long before it can spawn enough
  // conhost/pwsh processes to exhaust memory on Windows.
  MAX_TERMINAL_SESSIONS: 50,
} as const;
