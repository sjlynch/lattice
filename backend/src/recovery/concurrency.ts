// Bounded fan-out for the recovery sweeps: run `fn` over `items` with at most
// `limit` in flight, admitted in list order. The worker itself must isolate
// its errors (every caller wraps `fn` in try/catch) — a rejection here is a
// programming error and propagates like a sequential loop's would.
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}
