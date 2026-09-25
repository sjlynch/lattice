// Set before listen: callbacks and starts must see the recovered registry.
// A bounded wait returns 503 + Retry-After instead of acknowledging lost work.
//
// "Done" means the persisted runs are back in the registry (resume calls the
// finisher once every project's runs are registered, before redispatching any
// step), which is exactly when `getActiveRunsForProject` becomes authoritative.
// `/ws/workflow-runs` reads `isWorkflowRecoveryDone()` so a client that
// reconnects during the restart window gets a `recovering` hello instead of an
// empty snapshot it would read as "the run vanished".
let recovery: Promise<void> = Promise.resolve();
let recoveryDone = true;

export function beginWorkflowRecovery(): () => void {
  let resolveRecovery!: () => void;
  recoveryDone = false;
  const pending = new Promise<void>((resolve) => { resolveRecovery = resolve; });
  recovery = pending;
  // Idempotent (resume calls it at registry-ready AND in a `finally`). Only
  // the latest begin's finisher flips the flag, so a stale finisher from an
  // earlier begin can't declare a newer recovery done.
  return () => {
    if (recovery === pending) recoveryDone = true;
    resolveRecovery();
  };
}

export function isWorkflowRecoveryDone(): boolean {
  return recoveryDone;
}

// Resolves when the CURRENT recovery finishes (immediately when none is
// pending). Unbounded — use `waitForWorkflowRecovery` on request paths.
export function whenWorkflowRecoveryDone(): Promise<void> {
  return recovery;
}

export async function waitForWorkflowRecovery(timeoutMs = 10_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      recovery.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
