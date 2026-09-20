// A minimal bounded-concurrency gate: at most `max` `run()` bodies execute at
// once; the rest wait in FIFO order. Waiters hold only their closure, so a
// burst of N calls costs N small objects, never N in-flight I/O operations.
//
// Used to fence fan-out that is otherwise unbounded — e.g. the health watcher
// turning a 5,000-file checkout into 5,000 overlapping `fs.readFile`s (which
// saturates libuv's 4-thread pool for every other async fs op in the backend)
// with all 5,000 file bodies buffered ahead of a single serial analyzer.
export type ConcurrencyLimiter = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  // Diagnostics / tests.
  readonly active: number;
  readonly waiting: number;
};

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  if (!Number.isInteger(max) || max < 1) throw new Error(`concurrency limit must be >= 1, got ${max}`);
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}
