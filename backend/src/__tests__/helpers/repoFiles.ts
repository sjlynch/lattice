// The repo's own files for the doc guards (docBudget, docPaths): everything
// under the repo root except dot-dirs, dependencies and build/test output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', 'coverage']);

// Repo-relative, forward-slash paths.
export function listRepoFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else {
        out.push(path.relative(REPO_ROOT, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(REPO_ROOT);
  return out;
}

export function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// Auto-loaded: Claude Code injects every CLAUDE.md on the path to a file it reads.
export const isAgentDoc = (rel: string): boolean => /(^|\/)CLAUDE\.md$/.test(rel);

// Read on demand: a MAP.md beside a CLAUDE.md, and the top-level docs/*.md.
export const isOnDemandDoc = (rel: string): boolean => /(^|\/)MAP\.md$/.test(rel) || /^docs\/[^/]+\.md$/.test(rel);
