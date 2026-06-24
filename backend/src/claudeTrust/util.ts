// Tiny shared primitives for the `~/.claude.json` I/O + locking modules.
// Kept in one place so the writer, the mutex, and the maintenance sweeps share
// a single definition of "wait" and "best-effort remove".
import fs from 'node:fs/promises';

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Best-effort removal on cleanup paths where a failure is non-fatal — the path
// may already be gone, or be briefly held open by another process. Dedupes the
// `fs.unlink(...).catch(() => {})` / `fs.rmdir(...).catch(() => {})` idiom that
// the atomic writer and the mkdir mutex would otherwise each spell out.
export function unlinkQuietly(p: string): Promise<void> {
  return fs.unlink(p).catch(() => {});
}

export function rmdirQuietly(p: string): Promise<void> {
  return fs.rmdir(p).catch(() => {});
}
