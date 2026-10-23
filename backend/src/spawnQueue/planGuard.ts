// Plan guard: hold new fan-out spawns (`batch`: task runs, workflow steps) of a
// Claude or Codex agent while that provider's subscription plan has used at
// least `percent` of a 5-hour or weekly window. A long workflow then waits for
// the window to reset instead of running agents into the limit (Claude stops
// mid-turn) or onto paid credits (Codex draws them once the plan is spent).
//
// Like the resource governor: held requests stay pending and the queue's poll
// loop re-checks, nothing is dropped, `priority` / `interactive` spawns
// (resolvers, push, a user's own click) are never held, and Pi agents never
// are. The check is synchronous over the last plan-usage read; a read older
// than REFRESH_MS is refreshed in the background and `onChange` re-drains the
// queue when it lands. A window whose reset time has passed no longer holds,
// even before the next read. Model-only windows (`week-opus`, `week-sonnet`)
// are skipped: they bind one model, and the spawn's model isn't known here.
// Off unless `globalSettings.planGuardPercent` is set (1–100).

import type { PlanUsageProviderId, PlanUsageReport } from '../planUsage/types.js';

export const REFRESH_MS = 90_000;

export type PlanHold = {
  provider: PlanUsageProviderId;
  window: string;
  usedPercent: number;
  resetsAt?: string;
  reason: string;
};

const PROVIDER_OF: Record<string, PlanUsageProviderId> = { claude: 'claude', codex: 'codex' };
const NAME: Record<PlanUsageProviderId, string> = { claude: 'Claude', codex: 'Codex' };

export class PlanGuard {
  private percent: number | null = null;
  private report: PlanUsageReport | null = null;
  private readAt = 0;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly read: () => Promise<PlanUsageReport>,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  // null / 0 turns the guard off.
  setPercent(percent: number | null | undefined): void {
    this.percent = typeof percent === 'number' && percent > 0 ? Math.min(100, percent) : null;
    if (this.percent !== null) this.refreshIfStale();
  }

  getPercent(): number | null {
    return this.percent;
  }

  // For a caller that can wait (the workflow Start step): the first read, so
  // a guard just switched on doesn't wave the first launches through unseen.
  async ready(): Promise<void> {
    if (this.percent === null || this.report) return;
    this.refreshIfStale();
    await this.reading;
  }

  // Why a batch spawn of `harness` must wait, or null.
  holds(harness: string | undefined): PlanHold | null {
    const provider = harness ? PROVIDER_OF[harness] : undefined;
    if (this.percent === null || !provider) return null;
    this.refreshIfStale();
    const p = this.report?.providers.find((x) => x.provider === provider);
    if (!p || p.status !== 'ok') return null;
    const t = this.now();
    for (const w of p.windows) {
      if (w.id.startsWith('week-') || w.usedPercent < this.percent) continue;
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      if (!Number.isNaN(reset) && reset <= t) continue;
      return {
        provider,
        window: w.label,
        usedPercent: w.usedPercent,
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
        reason:
          `${NAME[provider]} plan ${w.label} at ${Math.round(w.usedPercent)}% ` +
          `(plan guard ${this.percent}%)${w.resetsAt ? `, resets ${w.resetsAt}` : ''}`,
      };
    }
    return null;
  }

  private refreshIfStale(): void {
    if (this.reading || this.now() - this.readAt < REFRESH_MS) return;
    this.reading = this.read()
      .then((r) => {
        this.report = r;
        this.onChange();
      })
      // Unreadable usage never holds anything: keep the last report.
      .catch(() => {})
      .finally(() => {
        this.reading = null;
        this.readAt = this.now();
      });
  }
}
