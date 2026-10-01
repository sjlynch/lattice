// Scan-specific eval program (CJS `require` + dynamic `import()` of ESM
// analysis modules by workerData URLs). Exported as a string from an ordinary
// backend module; worker/timer ownership stays in healthWorkerRunner.ts.
export const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
// Keep-alive: hold the worker's event loop open after the job loop finishes so
// it only exits on the parent's explicit terminate(). This makes 'exit' an
// unambiguous "we killed it / it crashed" signal and guarantees all posted
// messages (results + 'done') drain to the parent before any exit.
parentPort.on('message', () => {});
(async () => {
  let analyzeFile, readForAnalysis;
  try {
    const [analyzeMod, readMod] = await Promise.all([
      import(workerData.analyzeUrl),
      import(workerData.readUrl),
    ]);
    analyzeFile = analyzeMod.analyzeFile;
    readForAnalysis = readMod.readForAnalysis;
  } catch (err) {
    // e.g. running from src under tsx: the compiled .js siblings don't exist.
    parentPort.postMessage({ type: 'init-failed', error: String((err && err.message) || err) });
    return;
  }
  parentPort.postMessage({ type: 'ready' });
  for (const job of workerData.jobs) {
    let loc;
    try {
      const read = await readForAnalysis(job.filePath);
      loc = read.loc;
      if (read.content === undefined) {
        parentPort.postMessage({ type: 'result', index: job.index, loc: loc, ok: false });
        continue;
      }
      const res = await analyzeFile(read.content, job.ext, loc || 0);
      parentPort.postMessage({
        type: 'result', index: job.index, loc: loc, ok: true,
        metrics: res.metrics, imports: res.imports,
      });
    } catch (err) {
      parentPort.postMessage({ type: 'result', index: job.index, loc: loc, ok: false });
    }
  }
  parentPort.postMessage({ type: 'done' });
})();
`;
