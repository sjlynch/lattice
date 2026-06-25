// The reference-counted reason ledger behind the idle controller. The render
// loop runs while ANY reason is held (subject to the tab-hidden gate, applied
// by the orchestrator). This module is the single source of truth for the held
// counts and the two derived predicates the loop scheduler keys off — nothing
// here touches the graph or DOM, so it's trivially testable. See
// `idleController.ts` for what acquires/releases each reason and why.

export type Reason = 'engine' | 'interact' | 'refresh' | 'labelPhysics' | 'agents';

export type ReasonLedger = {
  acquire(reason: Reason): void;
  /** Guarded decrement — never drops a count below zero. */
  release(reason: Reason): void;
  /**
   * Any reason held — the render loop wants to run. The orchestrator ANDs this
   * with `!hidden` to form the loop scheduler's `shouldRun`.
   */
  anyHeld(): boolean;
  /**
   * True when the loop is running purely for the slow self-animations
   * (`agents` and/or `labelPhysics`) and nothing demands full responsiveness —
   * i.e. no `engine` warmup, `interact`, or `refresh` tail. This is the only
   * case the loop scheduler duty-cycles down to ~SLOW_FPS.
   */
  slowOnly(): boolean;
};

export function createReasonLedger(): ReasonLedger {
  const counts: Record<Reason, number> = {
    engine: 0,
    interact: 0,
    refresh: 0,
    labelPhysics: 0,
    agents: 0,
  };

  return {
    acquire(reason) {
      counts[reason]++;
    },
    release(reason) {
      if (counts[reason] > 0) counts[reason]--;
    },
    anyHeld() {
      return (
        counts.engine > 0 ||
        counts.interact > 0 ||
        counts.refresh > 0 ||
        counts.labelPhysics > 0 ||
        counts.agents > 0
      );
    },
    slowOnly() {
      return (
        counts.engine === 0 &&
        counts.interact === 0 &&
        counts.refresh === 0 &&
        (counts.agents > 0 || counts.labelPhysics > 0)
      );
    },
  };
}
