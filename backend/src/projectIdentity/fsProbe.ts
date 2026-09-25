// ENOENT-tolerant synchronous fs probes shared by the inventory and binding readers.
import fs from 'node:fs';

export function exists(file: string): boolean {
  try { fs.statSync(file); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function readDirectory(dir: string, directoriesOnly = false): string[] {
  try {
    return directoriesOnly
      ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : fs.readdirSync(dir);
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
