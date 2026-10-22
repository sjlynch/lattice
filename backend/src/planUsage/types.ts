// Wire types of GET /api/plan-usage (node-free: re-exported through
// ../shared/wireTypes.ts to the frontend).

export type PlanUsageProviderId = 'claude' | 'codex';

// `unavailable`: no sign-in found (or the CLI is missing); `expired`: the
// stored sign-in token has lapsed (the harness refreshes it on its next run —
// Lattice never does); `error`: the provider answered badly or not at all.
export type PlanUsageStatus = 'ok' | 'unavailable' | 'expired' | 'error';

export interface PlanUsageWindow {
  // Stable key: `session` (Claude 5-hour), `week`, `week-opus`, `week-sonnet`,
  // `primary` / `secondary` (Codex, labelled from the window length).
  id: string;
  label: string;
  usedPercent: number;
  windowMinutes?: number;
  // ISO timestamp.
  resetsAt?: string;
}

export interface PlanUsageProvider {
  provider: PlanUsageProviderId;
  status: PlanUsageStatus;
  // Human plan name when known, e.g. "Max 20x", "Pro".
  plan?: string;
  windows: PlanUsageWindow[];
  // Short extra facts: extra usage on/off, credit balance, free resets left.
  notes: string[];
  // Why the status isn't `ok`.
  message?: string;
  // Where the numbers came from, e.g. "Claude usage API", "Codex app-server",
  // "Codex session log". A session-log snapshot is as old as `asOf`.
  source: string;
  // When the numbers were true (ISO): the fetch time, or a snapshot's time.
  asOf: string;
}

export interface PlanUsageReport {
  providers: PlanUsageProvider[];
}
