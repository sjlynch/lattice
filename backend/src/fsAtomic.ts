// Crash-safe file replacement: write a uniquely named temp beside the target,
// then rename over it. A reader sees the old file or the new one, never a
// half-written one. The temp is removed on any failure (orphaned
// `.lattice-*.tmp` files once piled up to ~8 MB next to ~/.claude.json), and
// the rename is retried through transient Windows locks (EPERM/EBUSY/EACCES:
// antivirus, an editor, another reader holding the file open).
//
// The general-purpose writer for every JSON store/config under ~/.lattice and
// in projects. (It used to live in claudeTrust/configFile.ts, which re-exports
// it for the ~/.claude.json writer.) The terminal-server imports it:
// fingerprinted.

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Suffix of every atomic-write temp file (sweeps recognise orphans by it).
export const TEMP_SUFFIX = '.tmp';
const RENAME_RETRY_DELAYS_MS = [15, 30, 60, 120, 250];

export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.lattice-${process.pid}-${Date.now()}-${randomUUID()}${TEMP_SUFFIX}`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || i >= RENAME_RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[i]));
    }
  }
}
