// Adaptive admission for fan-out spawns: hold new `batch` spawns (task runs,
// workflow steps) while the machine is already saturated.
//
// `softCap` is a fixed number the user picks (`maxConcurrentAgents`), but what
// a machine can sustain depends on the repo and the moment — on 2026-09-22 a
// 50-agent cap on a large repo pinned the CPU at 100% (agents running test
// suites, multi-GB worktree checkouts, Defender scanning every written file)
// until the desktop froze. The governor keeps the cap as the ceiling and adds a
// live brake beneath it:
//
//   - CPU: an exponentially-smoothed system utilization (≈20 s window) from
//     os.cpus() deltas. Batch admission stops at ≥ CPU_BLOCK_PCT and resumes
//     below CPU_RESUME_PCT (hysteresis, so it doesn't flap per poll).
//   - Memory: batch admission stops while free RAM is under the floor.
//   - Floor: with fewer than MIN_LIVE_AGENTS sessions live the brake never
//     applies — load from something outside Lattice can't starve it to zero.
//   - `priority` / `interactive` spawns (merge resolvers, push, user one-offs)
//     are never held: they unblock work in flight or are explicit clicks.
//
// Held requests stay pending; the queue's poll loop (1.5 s while anything is
// pending) re-checks. Nothing is dropped. Opt out with
// `globalSettings.resourceGovernor: false`.

import os from 'node:os';

export const CPU_BLOCK_PCT = 90;
export const CPU_RESUME_PCT = 75;
const CPU_SMOOTHING_WINDOW_MS = 20_000;
const MIN_FREE_MEM_BYTES = 2 * 1024 ** 3;
const MIN_FREE_MEM_FRACTION = 0.05;
export const MIN_LIVE_AGENTS = 2;

type CpuTimes = { idle: number; total: number };

export type GovernorSampler = {
  cpuTimes: () => CpuTimes;
  freeMem: () => number;
  totalMem: () => number;
  now: () => number;
};

const osSampler: GovernorSampler = {
  cpuTimes: () => {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
    }
    return { idle, total };
  },
  freeMem: () => os.freemem(),
  totalMem: () => os.totalmem(),
  now: () => Date.now(),
};

export type GovernorState = {
  cpuPct: number | null;
  freeMemBytes: number;
  holdingBatch: boolean;
  reason: string | null;
};

export class ResourceGovernor {
  private enabled = true;
  private last: { times: CpuTimes; at: number } | null = null;
  private cpuEwma: number | null = null;
  private cpuHot = false;
  private reason: string | null = null;

  constructor(private readonly sampler: GovernorSampler = osSampler) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.cpuHot = false;
      this.reason = null;
    }
  }

  // Fold in a CPU sample. Cheap; called on every drain.
  sample(): void {
    const times = this.sampler.cpuTimes();
    const at = this.sampler.now();
    if (this.last) {
      const dTotal = times.total - this.last.times.total;
      const dIdle = times.idle - this.last.times.idle;
      const dt = at - this.last.at;
      if (dTotal > 0 && dt > 0) {
        const pct = Math.min(100, Math.max(0, (100 * (dTotal - dIdle)) / dTotal));
        const alpha = 1 - Math.exp(-dt / CPU_SMOOTHING_WINDOW_MS);
        this.cpuEwma = this.cpuEwma === null ? pct : this.cpuEwma + alpha * (pct - this.cpuEwma);
      }
    }
    this.last = { times, at };
    if (this.cpuEwma !== null) {
      if (!this.cpuHot && this.cpuEwma >= CPU_BLOCK_PCT) this.cpuHot = true;
      else if (this.cpuHot && this.cpuEwma < CPU_RESUME_PCT) this.cpuHot = false;
    }
  }

  // Should a batch spawn be held right now? `liveSessions` is the queue's
  // effective live count (sessions + in-flight spawns).
  holdsBatch(liveSessions: number): boolean {
    let reason: string | null = null;
    if (this.enabled && liveSessions >= MIN_LIVE_AGENTS) {
      const free = this.sampler.freeMem();
      const floor = Math.max(MIN_FREE_MEM_BYTES, this.sampler.totalMem() * MIN_FREE_MEM_FRACTION);
      if (this.cpuHot) {
        reason = `CPU at ${Math.round(this.cpuEwma ?? 0)}% (holding new agents until it drops below ${CPU_RESUME_PCT}%)`;
      } else if (free < floor) {
        reason = `only ${(free / 1024 ** 3).toFixed(1)} GB RAM free (holding new agents until ${(floor / 1024 ** 3).toFixed(1)} GB is free)`;
      }
    }
    if (reason !== this.reason) {
      if (reason) console.warn(`[spawn-queue] resource governor: ${reason}`);
      else if (this.reason) console.log('[spawn-queue] resource governor: load back to normal — admitting new agents');
      this.reason = reason;
    }
    return reason !== null;
  }

  state(): GovernorState {
    return {
      cpuPct: this.cpuEwma === null ? null : Math.round(this.cpuEwma),
      freeMemBytes: this.sampler.freeMem(),
      holdingBatch: this.reason !== null,
      reason: this.reason,
    };
  }
}
