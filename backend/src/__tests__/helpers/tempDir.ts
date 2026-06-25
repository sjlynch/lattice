// Shared filesystem fixtures for the unit suites. Kept out of the `*.test.ts`
// glob (npm test runs `src/__tests__/*.test.ts`, single-level) so it's importable
// by tests without being collected as one.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Make a throwaway temp dir, run `fn` against it, and always clean it up.
export async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Write a {relativePath: contents} layout under `dir`, creating parent dirs.
// Returns the dir for chaining. Forward slashes in keys work cross-platform.
export async function writeLayout(
  dir: string,
  files: Record<string, string>,
): Promise<string> {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, 'utf8');
  }
  return dir;
}
