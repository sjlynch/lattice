// Hand-written declarations for the orchestrator's health poll, so the
// backend test suite gets types. Keep in sync with health.mjs.

export function probeHealth(url: string): Promise<boolean>;
export function waitForHealth(url: string, timeoutMs: number): Promise<boolean>;
