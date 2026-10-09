// Shared fixtures for the split oneOffRunResume.* suites (mirrors, store,
// boot). Not a `*.test.ts` file, so it isn't collected as a suite.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function mkProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-oneoff-resume-'));
}

export async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}
