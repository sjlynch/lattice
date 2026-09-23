// At most MAX_CONCURRENT_CHECKOUTS `git worktree add`s at once, machine-wide.
//
// A checkout of a large repo is gigabytes of writes plus a Git LFS smudge per
// file (6.6 GB / ~54k files each on 2026-09-22), and the spawn queue admits up
// to `maxConcurrentAgents` task starts together. Run in parallel they thrash
// the disk, starve the running agents and — with on-access antivirus scanning
// every new file — pinned the CPU at 100%. Running them two at a time finishes
// each sooner and leaves the machine usable; a small repo's checkout takes
// milliseconds, so the gate costs nothing there. FIFO, so starts keep their
// queue order.

const MAX_CONCURRENT_CHECKOUTS = 2;

let active = 0;
const waiters: Array<() => void> = [];

export async function withCheckoutSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_CHECKOUTS) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    active += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    // Hand the slot straight to the next waiter (active stays the same).
    if (next) next();
    else active -= 1;
  }
}
