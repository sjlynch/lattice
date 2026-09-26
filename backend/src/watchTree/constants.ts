// Coalesce the burst a single editor save / git op / build step emits into one
// pass over the changed paths.
export const FLUSH_DEBOUNCE_MS = 100;
// A file whose mtime is younger than this is probably still being written, so
// hold it for another pass rather than analyzing a half-written file. This is
// the cheap stand-in for chokidar's awaitWriteFinish.
export const WRITE_STABILITY_MS = 100;
// ...but never hold one forever: a continuously-appended file (a log, a dev
// server's output) would otherwise never be reported at all.
export const MAX_STABILITY_RETRIES = 20;
export const CHOKIDAR_POLL_INTERVAL_MS = 50;

// Windows and (by default) macOS resolve paths case-insensitively, which is
// what makes a case-only rename invisible to a plain stat diff.
export const CASE_INSENSITIVE_FS =
  process.platform === 'win32' || process.platform === 'darwin';
