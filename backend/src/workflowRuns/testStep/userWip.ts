// The user's work in progress, as a Run tests step sees it.
//
// A Run tests agent works directly on the project's main checkout, which often
// carries the user's own uncommitted edits (ody's checkout: ~1,600 files). At
// step start Lattice records EVERY path that is modified, staged or untracked
// into `<stepdir>/USER_WIP.txt`; the brief tells the agent not to edit, stage
// or revert any of them, the post-check warns when a step commit touched one,
// and a timeout reports only the uncommitted paths that are NOT on it (what
// the agent left behind).
//
// Parsed from `git status --porcelain=v1 -z`: NUL-terminated, paths verbatim
// (no C-quoting, so spaces / quotes / non-ASCII come through as-is) and a
// rename or copy carries TWO paths — `XY new\0orig\0` — both of which count.
// An untracked directory is reported once as `dir/`; `wipCovers` treats such an
// entry as covering everything beneath it.

import fs from 'node:fs/promises';
import path from 'node:path';

export const USER_WIP_FILENAME = 'USER_WIP.txt';

// Every path in a porcelain v1 `-z` status, in output order, deduplicated.
export function parsePorcelainZ(stdout: string): string[] {
  const parts = stdout.split('\0');
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined): void => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    // `XY PATH` — two status letters, a space, the path. Anything shorter is
    // the trailing empty element after the last NUL (or garbage).
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const xy = entry.slice(0, 2);
    add(entry.slice(3));
    // Rename / copy: the ORIGINAL path follows as its own NUL-terminated field.
    if (/[RC]/.test(xy)) {
      i += 1;
      add(parts[i]);
    }
  }
  return out;
}

// Does the WIP list cover `repoPath`? Exact match, or under a listed untracked
// directory (`dir/`). Paths are repo-relative with forward slashes (git's
// spelling on every platform); the compare is case-insensitive on Windows.
export function wipCovers(wip: readonly string[], repoPath: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = norm(repoPath);
  for (const raw of wip) {
    const entry = norm(raw);
    if (entry === target) return true;
    if (entry.endsWith('/') && target.startsWith(entry)) return true;
  }
  return false;
}

// USER_WIP.txt: a short header (lines starting with `#`) then one path per
// line. A path containing a newline can't be represented on one line; it is
// written with the newline escaped, which is still enough for the agent to
// recognise it (and git status would C-quote it anyway in any other view).
export function renderUserWipFile(paths: readonly string[]): string {
  const header = [
    '# Files that were modified, staged or untracked in the project checkout when',
    '# this Run tests step started. They are the user\'s own work in progress:',
    '# do not edit, stage, revert, delete or commit any of them.',
    '# A path ending in "/" is an untracked directory (everything under it).',
    `# ${paths.length} path(s).`,
    '',
  ];
  return [...header, ...paths.map((p) => p.replace(/\r?\n/g, '\\n'))].join('\n') + '\n';
}

export function parseUserWipFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export async function writeUserWipFile(stepDir: string, paths: readonly string[]): Promise<string> {
  const file = path.join(stepDir, USER_WIP_FILENAME);
  await fs.writeFile(file, renderUserWipFile(paths), 'utf8');
  return file;
}

export async function readUserWipFile(stepDir: string): Promise<string[] | null> {
  try {
    return parseUserWipFile(await fs.readFile(path.join(stepDir, USER_WIP_FILENAME), 'utf8'));
  } catch {
    return null;
  }
}
