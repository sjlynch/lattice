// Per-key serialization of async read-modify-write operations.
//
// Settings persistence (userSettings.ts `patchUserSettings`, globalSettings.ts
// `updateGlobalSettings`, mcp/secrets.ts `setMcpSecret`/`mergeMcpSecrets`) does
// `read → {...base, ...partial} → fs.writeFile` with no locking. When two
// patches for the same target fire close together (e.g. toggling QA Playwright
// right after a sidebar-width drag ends, or two independent React hooks each
// PATCHing one field in response to a single interaction) both reads observe
// the same base, each merge folds in only its own field, and the later write
// clobbers the earlier one — silently reverting a user's setting on disk.
//
// `runExclusive(key, fn)` chains operations sharing a key through a promise so
// each `fn()` runs only after the previous op for that key has fully settled
// (read + merge + write). Each patch therefore reads the result of the prior
// write instead of a stale base, so disjoint fields accumulate instead of
// clobbering. Different keys run concurrently. The chain is in-process, which
// matches our single-backend topology (same scope as mergeLocks.ts).

const chains = new Map<string, Promise<unknown>>();

export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Run `fn` once `prev` settles — either branch of `.then(fn, fn)` so a failed
  // prior write doesn't wedge the key forever. `run` carries fn's real
  // result/rejection back to this caller.
  const run = prev.then(fn, fn);
  // `tail` is what later ops chain off; it never rejects, so a caller who
  // ignores its result can't trip an unhandledRejection and the next op still
  // waits its turn.
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  // Prune the map once this is the last queued op for the key, so it doesn't
  // grow without bound across many distinct projects/files.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
