// Set before listen: callbacks and starts must see the recovered registry.
// A bounded wait returns 503 + Retry-After instead of acknowledging lost work.
let recovery: Promise<void> = Promise.resolve();

export function beginWorkflowRecovery(): () => void {
  let finish!: () => void;
  recovery = new Promise<void>((resolve) => { finish = resolve; });
  return finish;
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
