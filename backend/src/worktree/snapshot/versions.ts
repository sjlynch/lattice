import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// Read the link itself, never its target. Content hashes also distinguish edits
// that preserve a file's length or filesystem timestamp granularity.
export async function pathVersion(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return `link:${await fs.readlink(file)}`;
    if (!stat.isFile()) return `other:${stat.mode}`;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return `file:${hash.digest('hex')}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
