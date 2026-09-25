// Exclusion between engine runs and rule-pack tree mutations.
//
// A scan's engine reads `~/.lattice/opengrep/rules/<packId>/` for its whole
// run; a pack install swaps that directory (two renames) and a removal deletes
// it. Overlapping them silently drops the pack from a scan whose digest still
// looks complete, or fails the rename with EBUSY on Windows. The routes'
// request-time `isAnyOpengrepScanRunning()` check cannot close that race: an
// install's swap happens seconds to minutes after its request, and scans (the
// workflow pre-run hook, MCP, API) never went through a route that checked for
// an install.
//
// So this is a small reader/writer gate, writer-preferring:
//   - a scan holds a READ slot from just before it resolves its rule configs
//     until its engine exits (`acquireRulesRead`);
//   - a mutation (`withRulesMutation`) first blocks NEW readers, then waits for
//     the running ones to drain (or refuses, `wait: false`), runs, and
//     unblocks. Mutations run one at a time.
// A scan that arrives during a mutation simply waits for it; a mutation never
// starves behind a stream of scans because pending writers block new reads.

export class OpengrepRulesBusyError extends Error {
  constructor() {
    super('An Opengrep scan is running; wait for it to finish before changing rule packs.');
  }
}

// How long a mutation that is allowed to wait gives the running scans. A scan's
// default hard cap is 10 min (scan.ts DEFAULT_SCAN_TIMEOUT_MS); a margin on top
// covers the engine's kill + the JSON read after it.
export const RULES_MUTATION_WAIT_MS = 12 * 60_000;

let activeReads = 0;
let pendingMutations = 0;
let mutationChain: Promise<void> = Promise.resolve();
// Waiters woken when the last pending mutation finishes (readers) or the last
// running read releases (mutations).
let readerWaiters: Array<() => void> = [];
let drainWaiters: Array<() => void> = [];

function wake(list: Array<() => void>): void {
  for (const w of list) w();
}

export function activeRulesReads(): number {
  return activeReads;
}

export function isRulesMutationPending(): boolean {
  return pendingMutations > 0;
}

function abortError(): Error {
  const err = new Error('aborted while waiting for a rule-pack change to finish');
  err.name = 'AbortError';
  return err;
}

// Take a read slot, waiting out any pending/running mutation first. Returns the
// release (idempotent). Rejects with an AbortError if `signal` fires while
// waiting.
export async function acquireRulesRead(signal?: AbortSignal): Promise<() => void> {
  while (pendingMutations > 0) {
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        readerWaiters = readerWaiters.filter((w) => w !== done);
        reject(abortError());
      };
      const done = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      readerWaiters.push(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  if (signal?.aborted) throw abortError();
  activeReads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeReads -= 1;
    if (activeReads === 0) {
      const list = drainWaiters;
      drainWaiters = [];
      wake(list);
    }
  };
}

function waitForReadsToDrain(timeoutMs: number): Promise<boolean> {
  if (activeReads === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      drainWaiters = drainWaiters.filter((w) => w !== done);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    drainWaiters.push(done);
  });
}

// Run `fn` with the rules tree exclusively held. `wait: true` waits (up to
// `waitMs`) for running scans to finish; `wait: false` refuses at once with
// OpengrepRulesBusyError when one is running. Either way new scans are held
// off from the moment this is called until `fn` settles.
export async function withRulesMutation<T>(
  fn: () => Promise<T>,
  opts: { wait: boolean; waitMs?: number },
): Promise<T> {
  pendingMutations += 1;
  const previous = mutationChain;
  let finished!: () => void;
  mutationChain = new Promise<void>((resolve) => {
    finished = resolve;
  });
  try {
    await previous;
    if (activeReads > 0) {
      if (!opts.wait) throw new OpengrepRulesBusyError();
      const drained = await waitForReadsToDrain(opts.waitMs ?? RULES_MUTATION_WAIT_MS);
      if (!drained) throw new OpengrepRulesBusyError();
    }
    return await fn();
  } finally {
    pendingMutations -= 1;
    finished();
    if (pendingMutations === 0) {
      const list = readerWaiters;
      readerWaiters = [];
      wake(list);
    }
  }
}
