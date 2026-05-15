import fs from 'node:fs';

export async function watchDist(onChange) {
  // fs.watch({recursive}) covers Windows + macOS. On Linux it throws
  // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM — fall back to chokidar there.
  try {
    const w = fs.watch('dist', { recursive: true }, () => onChange());
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
    const mod = await import('chokidar');
    const watch = mod.watch ?? mod.default?.watch ?? mod.default;
    const w = watch('dist', { ignoreInitial: true });
    w.on('all', () => onChange());
    console.log('[lattice-backend] watching dist/ (chokidar)');
    return () => {
      void w.close();
    };
  } catch (err) {
    console.warn(
      '[lattice-backend] could not watch dist/ — auto-restart disabled; restart `npm run dev` after backend changes.',
      err,
    );
    return () => {};
  }
}
