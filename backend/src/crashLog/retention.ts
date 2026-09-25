// Retention for ~/.lattice/logs: which files crashLog owns, bucketed by kind,
// and pruning each bucket to the newest KEEP_FILES so a crash loop can't fill
// the disk.

import fs from 'node:fs';
import path from 'node:path';

export const KEEP_FILES = 20;

// Which retention bucket a log file belongs to, or null if we don't own it.
//
// `-nojs` files get their OWN bucket rather than sharing the `crash-` one. They
// are written on a different trigger (a boot noticing a process that vanished)
// and can arrive in bursts — anything that force-kills the backend repeatedly
// produces one per kill. Sharing a bucket would let such a burst evict the
// handler-written crash files, which are the richer record and exactly what
// you'd be looking for.
export function retentionBucket(name: string): string | null {
  if (name.startsWith('report.')) return 'report';
  if (!name.startsWith('crash-')) return null;
  return name.endsWith('-nojs.log') ? 'crash-nojs' : 'crash';
}

// Keep the newest KEEP_FILES of each kind so a crash loop can't fill the disk.
// Ordered by FILENAME, not mtime: every kind embeds a timestamp as its first
// field, so a lexicographic sort is chronological — and unlike mtime it can't be
// perturbed by anything that touches the files afterwards.
export function pruneOldFiles(dir: string): void {
  try {
    const names = fs.readdirSync(dir);
    const buckets = new Map<string, string[]>();
    for (const name of names) {
      const bucket = retentionBucket(name);
      if (!bucket) continue;
      const list = buckets.get(bucket) ?? [];
      list.push(name);
      buckets.set(bucket, list);
    }
    for (const group of [...buckets.values()].map((g) => g.sort().reverse())) {
      for (const stale of group.slice(KEEP_FILES)) {
        try {
          fs.unlinkSync(path.join(dir, stale));
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }
}
