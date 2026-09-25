// Constants shared by both content-search paths (search/jsGrepWorker.ts and
// ripgrep.ts), so the rg fast-path and the JS fallback poll alike.

// How often each path checks the caller's `isCancelled` (a superseded
// debounced request) while a search is running.
export const CANCEL_POLL_MS = 100;
