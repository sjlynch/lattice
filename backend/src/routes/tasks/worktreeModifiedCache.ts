export type TtlCacheEntry<T> = {
  expires: number;
  value: T;
};

export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, TtlCacheEntry<T>>();

  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      entries.set(key, { expires: now() + ttlMs, value });
    },
    clear(): void {
      entries.clear();
    },
  };
}
