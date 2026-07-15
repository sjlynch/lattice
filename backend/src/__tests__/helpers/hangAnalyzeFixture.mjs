// Plain-JS analysis stand-in loaded BY the real health worker (via moduleUrls)
// so a test can trigger a genuine, uninterruptible-from-inside infinite loop on
// the worker's thread — the real-world shape of a catastrophic-backtracking
// regex. It exports the same surface the worker imports: readForAnalysis +
// analyzeFile. Kept as .mjs (not .ts) so the worker's plain-Node runtime
// (execArgv: []) can dynamically import it without a TS loader.

export async function readForAnalysis(filePath) {
  // Echo the path as "content" so analyzeFile can decide whether to hang
  // (analyzeFile only receives content, not the path).
  return { loc: 1, content: filePath };
}

export async function analyzeFile(content /* = filePath */) {
  if (String(content).includes('HANG')) {
    // Simulate catastrophic backtracking: spin forever on this thread.
    // The parent's watchdog must terminate the worker to recover.
    while (true) {
      /* pin the worker thread */
    }
  }
  return { metrics: { score: 100, loc: 1 }, imports: [] };
}
