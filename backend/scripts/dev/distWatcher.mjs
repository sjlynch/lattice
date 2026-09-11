import fs from 'node:fs';

export async function watchDist(onChange, { watchNative = fs.watch, loadChokidar = () => import('chokidar') } = {}) {
  // fs.watch({recursive}) covers Windows + macOS. On Linux it throws
  // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM — fall back to chokidar there.
  try {
    // Forward eventType/filename: the restart log used to say only "dist/
    // changed", which made an unexplained restart impossible to attribute
    // after the fact.
    const w = watchNative('dist', { recursive: true }, (eventType, filename) =>
      onChange(eventType, filename),
    );
    w.on('error', (err) => {
      console.warn('[lattice-backend] dist/ watcher error — auto-restart may be unavailable:', err);
    });
    console.log('[lattice-backend] watching dist/ (fs.watch)');
    return () => {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* fall through */
  }
  try {
    const mod = await loadChokidar();
    const watch = mod.watch ?? mod.default?.watch ?? mod.default;
    const w = watch('dist', { ignoreInitial: true });
    w.on('all', (eventType, filePath) => onChange(eventType, filePath));
    w.on('error', (err) => {
      console.warn('[lattice-backend] dist/ watcher error — auto-restart may be unavailable:', err);
    });
    console.log('[lattice-backend] watching dist/ (chokidar)');
    return () => {
      void Promise.resolve(w.close()).catch((err) => {
        console.warn('[lattice-backend] could not close dist/ watcher:', err);
      });
    };
  } catch (err) {
    console.warn(
      '[lattice-backend] could not watch dist/ — auto-restart disabled; restart `npm run dev` after backend changes.',
      err,
    );
    return () => {};
  }
}
