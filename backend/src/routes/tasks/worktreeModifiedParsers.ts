import path from 'node:path';
import { canonicalProjectPath } from '../../projectPath.js';
import { parseStatusRecords } from '../../worktree/snapshot/pathClassification.js';
import { isManaged } from './activity.js';

export function parseNulPaths(out: string): string[] {
  return out.split('\0').filter((p) => p.length > 0);
}

export function parsePorcelainPaths(out: string): string[] {
  return parseStatusRecords(out)
    .filter((record) => record.x !== ' ' || record.y !== ' ')
    .map((record) => record.file);
}

export function toProjectAbsolutePaths(
  projectPath: string,
  rels: Iterable<string>,
): string[] {
  const root = canonicalProjectPath(projectPath);
  const out: string[] = [];
  for (const rel of rels) {
    if (!rel || isManaged(rel)) continue;
    out.push(path.join(root, rel));
  }
  return out;
}
