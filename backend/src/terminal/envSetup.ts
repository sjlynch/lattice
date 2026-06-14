// Claude Code does several pieces of background work on every launch that are
// pure overhead for an orchestrated agent: an autoupdater check (which can
// spawn an updater child process), telemetry + error-reporting uploads, and
// non-essential background model calls (conversation titling and similar).
// Under "Run All" / workflow fan-out there can be dozens of Claude processes
// alive at once, so that per-process overhead multiplies and competes for
// CPU + network with the work the user actually queued. Disable it for every
// pty Lattice spawns. Applied as defaults only — a value already present in
// the environment (the user opting in or out themselves) is left untouched.
const CLAUDE_OVERHEAD_ENV: Record<string, string> = {
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
};

export function applyClaudeOverheadEnv(env: { [key: string]: string }): void {
  for (const [key, value] of Object.entries(CLAUDE_OVERHEAD_ENV)) {
    if (!env[key]) env[key] = value;
  }
}
