// Plan usage for the harnesses that bill against a subscription: Claude (via
// the usage API Claude Code's /usage reads) and Codex (via Codex's own
// app-server). GET /api/plan-usage, the top-bar usage chip and the MCP
// `plan_usage` tool read it here.
//
// Cached in memory per provider: a plain read reuses a result up to 60 s old,
// `refresh` forces a new one unless the last is under 15 s old, and concurrent
// reads share one in-flight fetch — so polling tabs and agents never hammer
// either provider. Nothing is persisted.

import { readClaudeUsage } from './planUsage/claude.js';
import { readCodexUsage } from './planUsage/codex.js';
import type { PlanUsageProvider, PlanUsageProviderId, PlanUsageReport } from './planUsage/types.js';

export type PlanUsageReaders = Record<PlanUsageProviderId, () => Promise<PlanUsageProvider>>;

const FRESH_MS = 60_000;
const MIN_REFRESH_MS = 15_000;

export function createPlanUsageService(readers: PlanUsageReaders, now: () => number = Date.now) {
  const cache = new Map<PlanUsageProviderId, { at: number; value: PlanUsageProvider }>();
  const inFlight = new Map<PlanUsageProviderId, Promise<PlanUsageProvider>>();

  const one = (id: PlanUsageProviderId, refresh: boolean): Promise<PlanUsageProvider> => {
    const hit = cache.get(id);
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < (refresh ? MIN_REFRESH_MS : FRESH_MS)) return Promise.resolve(hit.value);
    const pending = inFlight.get(id);
    if (pending) return pending;
    const p = readers[id]()
      .then((value) => {
        cache.set(id, { at: now(), value });
        return value;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  };

  return {
    async read(opts: { refresh?: boolean } = {}): Promise<PlanUsageReport> {
      const ids: PlanUsageProviderId[] = ['claude', 'codex'];
      return { providers: await Promise.all(ids.map((id) => one(id, opts.refresh === true))) };
    },
  };
}

let shared: ReturnType<typeof createPlanUsageService> | null = null;

export function readPlanUsage(opts: { refresh?: boolean } = {}): Promise<PlanUsageReport> {
  shared ??= createPlanUsageService({ claude: () => readClaudeUsage(), codex: () => readCodexUsage() });
  return shared.read(opts);
}
