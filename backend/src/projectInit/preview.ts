// What would the first commit actually capture?
//
// The dialog's whole job is to stop a user committing a `.env` or a 2GB
// `node_modules` by accident, so it needs the file/byte count *before* the
// repo exists — which means counting them ourselves, since there is no git
// index to ask yet.
//
// The matcher below is deliberately lightweight. It only has to handle the
// pattern shapes Lattice itself generates (bare dir names, `dir/`, `*.ext`,
// `.env.*`) plus whatever the user types into the textarea, so it implements a
// useful subset of gitignore syntax and skips the rest (`!` negation,
// `**` spans, per-directory `.gitignore` files). This is DECISION SUPPORT for
// the dialog, not a guarantee: at commit time `git add -A` reads the real
// `.gitignore` with git's own semantics, and git is authoritative. A count
// that's slightly off makes the preview imprecise; it can't make the commit
// wrong.

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { buildStarterGitignore } from './gitignoreTemplate.js';
import { probeProjectGit } from './probe.js';
import type { ProjectInitPreview } from './types.js';

// A cap, not a budget: a folder with more files than this is already a "you
// probably don't want to commit this" answer, and the UI renders the counts as
// a lower bound once `truncated` is set.
const MAX_WALK_FILES = 20_000;
// Symlinks are never followed, so a cycle can't recurse forever — this only
// bounds a pathologically deep real tree against a stack overflow.
const MAX_WALK_DEPTH = 40;
const MAX_LARGEST = 5;

type IgnoreRule = {
  re: RegExp;
  /** `dir/` — matches directories only. */
  dirOnly: boolean;
  /** Pattern contained a slash → matched against the repo-relative path. */
  anchored: boolean;
};

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (const ch of glob) {
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Negation is the one gitignore feature we can't approximate safely, so a
    // `!` line is ignored outright rather than half-applied.
    if (line.startsWith('!')) continue;

    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    let anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line) continue;
    if (line.includes('/')) anchored = true;

    rules.push({ re: globToRegExp(line), dirOnly, anchored });
  }
  return rules;
}

export function buildIgnoreMatcher(
  text: string,
): (relPath: string, name: string, isDir: boolean) => boolean {
  const rules = parseIgnoreRules(text);
  return (relPath, name, isDir) => {
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      // An unanchored pattern matches at any depth, so it's tested against the
      // entry's own name; an anchored one against the repo-relative path.
      if (rule.re.test(rule.anchored ? relPath : name)) return true;
    }
    return false;
  };
}

type WalkAccumulator = {
  fileCount: number;
  byteCount: number;
  truncated: boolean;
  largest: Array<{ path: string; bytes: number }>;
};

function noteLargest(acc: WalkAccumulator, relPath: string, bytes: number): void {
  const smallest = acc.largest[acc.largest.length - 1];
  if (acc.largest.length >= MAX_LARGEST && smallest && bytes <= smallest.bytes) {
    return;
  }
  acc.largest.push({ path: relPath, bytes });
  acc.largest.sort((a, b) => b.bytes - a.bytes);
  if (acc.largest.length > MAX_LARGEST) acc.largest.length = MAX_LARGEST;
}

async function walk(
  dir: string,
  rel: string,
  depth: number,
  ignores: (relPath: string, name: string, isDir: boolean) => boolean,
  acc: WalkAccumulator,
): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — it contributes nothing rather than failing the preview
  }

  for (const entry of entries) {
    if (acc.fileCount >= MAX_WALK_FILES) {
      acc.truncated = true;
      return;
    }
    const name = entry.name;
    if (name === '.git') continue;
    // Never follow a reparse point: it can escape the project entirely, or
    // loop back into it. `git add` wouldn't recurse into one either.
    if (entry.isSymbolicLink()) continue;

    const childRel = rel ? `${rel}/${name}` : name;
    const full = path.join(dir, name);

    if (entry.isDirectory()) {
      if (ignores(childRel, name, true)) continue;
      if (depth >= MAX_WALK_DEPTH) {
        acc.truncated = true;
        continue;
      }
      await walk(full, childRel, depth + 1, ignores, acc);
      if (acc.truncated && acc.fileCount >= MAX_WALK_FILES) return;
    } else if (entry.isFile()) {
      if (ignores(childRel, name, false)) continue;
      let bytes = 0;
      try {
        bytes = (await fs.lstat(full)).size;
      } catch {
        continue;
      }
      acc.fileCount += 1;
      acc.byteCount += bytes;
      noteLargest(acc, childRel, bytes);
    }
  }
}

async function readOwnGitignore(root: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
}

export async function previewProjectInit(
  project: string,
  gitignore?: string,
): Promise<ProjectInitPreview> {
  const root = canonicalProjectPath(project);
  const probe = await probeProjectGit(root);

  // Precedence: the caller's edited text, then the project's own `.gitignore`
  // (which `initProjectGit` would leave alone), then a generated starter.
  let text = gitignore;
  let generated = false;
  if (text === undefined) {
    const own = await readOwnGitignore(root);
    if (own !== null) {
      text = own;
    } else {
      text = await buildStarterGitignore(root);
      generated = true;
    }
  }

  const acc: WalkAccumulator = {
    fileCount: 0,
    byteCount: 0,
    truncated: false,
    largest: [],
  };
  await walk(root, '', 0, buildIgnoreMatcher(text), acc);

  return {
    probe,
    isEmpty: acc.fileCount === 0,
    gitignore: text,
    generated,
    fileCount: acc.fileCount,
    byteCount: acc.byteCount,
    truncated: acc.truncated,
    largest: acc.largest,
  };
}
