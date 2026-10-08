// On-demand V8 heap snapshot for the backend (`POST /api/debug/heap-snapshot`).
// Take one, reproduce the suspected leak, take another, then load both into
// Chrome DevTools → Memory → Comparison. Writing blocks the event loop for a
// few seconds and briefly needs roughly the heap's size again in memory, so
// it only ever runs on an explicit request. Only the newest KEEP files are
// kept (snapshots are large).

import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

import { crashLogDir } from '../crashLog.js';

const KEEP = 4;

export function writeHeapSnapshotFile(label: string): string {
  const dir = crashLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = v8.writeHeapSnapshot(path.join(dir, `heap-${label}-${stamp}.heapsnapshot`));
  try {
    const prefix = `heap-${label}-`;
    const old = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.heapsnapshot'))
      .sort()
      .reverse()
      .slice(KEEP);
    for (const f of old) fs.unlinkSync(path.join(dir, f));
  } catch {
    /* retention is best-effort */
  }
  return file;
}
