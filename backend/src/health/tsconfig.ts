// tsconfig path-alias loader. We don't run a full TypeScript module
// resolver here — we just extract `compilerOptions.baseUrl` +
// `compilerOptions.paths` from every tsconfig.json we can find and
// expose them as a flat alias list. The cross-file resolver tries
// each alias in order before falling back to relative-path
// resolution; an alias hit short-circuits the rest of the lookup.
//
// Why we bother: real projects routinely rewrite imports to read
// `@/components/Foo` instead of `../../../components/Foo`. Without
// alias awareness our fan-in / fan-out on those projects undercounts
// by half or more (every aliased import looks like an external
// package and gets dropped). One self-hosted example: Lattice's own
// backend uses `lattice` (the parent package alias). Without this
// plumbing, every internal import in the backend is invisible to the
// graph.

import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORE_DIR_NAMES } from './constants.js';
import { walkSourceTree } from './walkTree.js';

export type ParsedAlias = {
  // Pattern prefix as it appears in tsconfig. For `@/*` this is `@/`;
  // for an exact `@app` it's `@app`.
  prefix: string;
  // True when the original pattern ended in `/*`, meaning the trailing
  // path segment is substituted into the matching base.
  isWildcard: boolean;
  // Absolute paths to try as substitutions, in declaration order.
  substitutions: string[];
};

const MAX_TSCONFIG_DEPTH = 4;
// Match tsconfig.json AND tsconfig.app.json / tsconfig.node.json /
// tsconfig.base.json — Vite + project-references projects routinely
// split paths across multiple files. Matching the prefix catches
// them all; non-tsconfig files would never parse with a
// `compilerOptions.paths` schema so the false positives are inert.
const TSCONFIG_RE = /^tsconfig(?:\..+)?\.json$/;

// Strip JSONC (line comments, block comments, trailing commas) so
// JSON.parse can handle a real-world tsconfig. We do this in a
// state-aware single pass instead of a regex sweep so `//` inside
// string values isn't accidentally treated as a comment.
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < n) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          out += ch;
          i++;
          break;
        }
        out += ch;
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    out += c;
    i++;
  }
  // Strip trailing commas before `}` / `]`.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function findTsconfigs(projectRoot: string): Promise<string[]> {
  // Shared bounded walker (health/walkTree.ts) with the canonical skip-dir set.
  // Dotfile dirs that aren't in IGNORE_DIR_NAMES (e.g. `.config`) are still
  // recursed into, so a tsconfig nested under one is discovered.
  const out: string[] = [];
  await walkSourceTree(projectRoot, {
    maxDepth: MAX_TSCONFIG_DEPTH,
    skipDirs: IGNORE_DIR_NAMES,
    onFile: (filePath, name) => {
      if (TSCONFIG_RE.test(name)) out.push(filePath);
    },
  });
  return out;
}

// Parse a single tsconfig file into a list of ParsedAlias entries
// rooted at the tsconfig's own baseUrl. Unreadable / unparseable /
// schema-mismatched files return an empty list rather than throwing
// — alias resolution is best-effort and we'd rather degrade quietly
// than break the scan.
async function parseTsconfig(tsconfigPath: string): Promise<ParsedAlias[]> {
  let raw: string;
  try {
    raw = await fs.readFile(tsconfigPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const co = (parsed as { compilerOptions?: unknown }).compilerOptions;
  if (!co || typeof co !== 'object') return [];

  const tsconfigDir = path.dirname(tsconfigPath);
  const hasExplicitBaseUrl =
    typeof (co as { baseUrl?: unknown }).baseUrl === 'string';
  const baseUrl = hasExplicitBaseUrl ? (co as { baseUrl: string }).baseUrl : '.';
  const baseDir = path.resolve(tsconfigDir, baseUrl);

  const out: ParsedAlias[] = [];
  const paths = (co as { paths?: unknown }).paths;
  for (const [pattern, subs] of Object.entries(
    (paths && typeof paths === 'object' ? paths : {}) as Record<string, unknown>,
  )) {
    if (!Array.isArray(subs) || subs.length === 0) continue;
    const isWildcard = pattern.endsWith('/*');
    const prefix = isWildcard ? pattern.slice(0, -1) : pattern;
    const substitutions: string[] = [];
    for (const s of subs) {
      if (typeof s !== 'string') continue;
      // The wildcard is a placeholder for whatever followed the
      // pattern's `/*`. We resolve to the base directory; the alias
      // resolver appends the captured tail at lookup time. So strip
      // the trailing wildcard regardless of whether it's `/*`
      // (`components/*`) or a bare `*` (just `*`).
      let stripped = s;
      if (stripped.endsWith('/*')) stripped = stripped.slice(0, -2);
      else if (stripped === '*') stripped = '';
      substitutions.push(path.resolve(baseDir, stripped));
    }
    if (substitutions.length > 0) {
      out.push({ prefix, isWildcard, substitutions });
    }
  }

  // baseUrl-relative bare imports: TS resolves `import 'src/foo'` against
  // baseUrl even with no matching `paths` entry. Emit a catch-all (bare
  // specifiers only — see resolveByAlias) so those edges land. Empty prefix
  // sorts last in loadProjectAliases, so explicit `paths` always win.
  if (hasExplicitBaseUrl) {
    out.push({ prefix: '', isWildcard: true, substitutions: [baseDir] });
  }

  return out;
}

// Walk the project for tsconfig.json files, parse each, return a
// merged + deduped alias list sorted by prefix length (longest first
// so a more-specific alias like `@components/` wins over `@`).
export async function loadProjectAliases(projectRoot: string): Promise<ParsedAlias[]> {
  const files = await findTsconfigs(projectRoot);
  if (files.length === 0) return [];
  const parsed = await Promise.all(files.map(parseTsconfig));
  const merged: ParsedAlias[] = [];
  // De-dupe on (prefix, isWildcard, substitutions[0]). Two tsconfigs
  // in a monorepo often define the same alias against the same root.
  const seen = new Set<string>();
  for (const list of parsed) {
    for (const a of list) {
      const key = `${a.prefix}|${a.isWildcard}|${a.substitutions[0] ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(a);
    }
  }
  merged.sort((a, b) => b.prefix.length - a.prefix.length);
  return merged;
}
