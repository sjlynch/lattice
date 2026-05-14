import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { IGNORE_DIR_NAMES } from '../health/constants.js';

export async function loadGitignore(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(Array.from(IGNORE_DIR_NAMES));
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // no .gitignore — fine
  }
  return ig;
}
