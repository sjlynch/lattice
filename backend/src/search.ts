// Content search across a project's source files. Backs `GET /api/search`
// (routes/search.ts), which the graph's search bar calls (debounced) to
// select every file whose *contents* match the query. Filename matching is
// done client-side off the already-loaded graph; this module is only the
// file-contents pass.
//
// Reuses the same gitignore + source-file collection the scanner uses, so the
// absolute paths returned here are byte-identical to the graph's file-node ids
// (a file node's `id` is its absolute path — see scanner/graphAggregate.ts).

import fs from 'node:fs/promises';
import { canonicalProjectPath } from './projectPath.js';
import { resolveRipgrep, searchWithRipgrep } from './ripgrep.js';
import { loadGitignore } from './scanner/ignore.js';
import { collectSourceFiles } from './scanner/collectSourceTree.js';

export type SearchOptions = {
  pattern: string;
  // When true `pattern` is a raw JS regex; otherwise it's a wildcard glob
  // (`*` → any run, `?` → one char), substring-matched case-insensitively.
  regex: boolean;
  // Cap on matching files returned. Selecting tens of thousands of nodes would
  // allocate that many halo sprites on the frontend, so we bound it.
  limit?: number;
  // Cooperative cancellation — the route wires this to req.on('close') so a
  // superseded debounced request stops reading files no one will look at.
  isCancelled?: () => boolean;
};

export type SearchResult = {
  // Absolute file paths == graph file-node ids.
  matches: string[];
  // Files actually read (excludes oversize/binary/unreadable skips).
  scanned: number;
  // True if we hit `limit` and stopped collecting.
  truncated: boolean;
};

const DEFAULT_LIMIT = 2000;
// Files larger than this are skipped for the content pass — they're almost
// always generated/data blobs, and reading multi-MB files on every keystroke
// is the dominant cost. They're still matchable by filename on the frontend.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Parallel file reads. The work is I/O-bound, so a modest pool keeps the
// event loop fed without thrashing the disk.
const READ_CONCURRENCY = 32;

// The regex *source string* for a query. KEEP THE WILDCARD TRANSLATION IN SYNC
// with the frontend's searchMatcher.ts so a wildcard query selects the same
// files whether the hit came from the filename pass (frontend) or the content
// pass (here / rg).
export function regexSource(pattern: string, regex: boolean): string {
  if (regex) return pattern;
  // Escape every regex metacharacter, then re-enable * and ? as wildcards.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
}

export async function searchProjectContents(
  root: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const absRoot = canonicalProjectPath(root);
  const source = regexSource(options.pattern, options.regex);
  // Compile up front: validates the pattern (invalid → throws → route 400) and
  // is reused by the JS fallback below.
  const re = new RegExp(source, 'i');
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

  // Fast path: hand the whole walk+match to ripgrep when it's available. On any
  // rg failure (e.g. a JS-only regex feature rg can't compile) fall through to
  // the JS path so results stay correct.
  const rg = await resolveRipgrep();
  if (rg) {
    try {
      const { matches, truncated } = await searchWithRipgrep(rg, absRoot, {
        regexSource: source,
        limit,
        maxFileBytes: MAX_FILE_BYTES,
        isCancelled: options.isCancelled,
      });
      return { matches, scanned: matches.length, truncated };
    } catch (err) {
      console.warn(
        '[search] ripgrep failed, falling back to JS grep:',
        (err as Error).message,
      );
    }
  }

  const ig = await loadGitignore(absRoot);
  const files = await collectSourceFiles(absRoot, ig);

  const matches: string[] = [];
  let scanned = 0;
  let truncated = false;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (options.isCancelled?.()) return;
      if (matches.length >= limit) {
        truncated = true;
        return;
      }
      const i = cursor++;
      if (i >= files.length) return;
      const file = files[i];
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        const buf = await fs.readFile(file);
        // Cheap binary guard: a NUL byte in the first 8 KB means it's not text.
        if (buf.subarray(0, 8192).includes(0)) continue;
        scanned++;
        if (re.test(buf.toString('utf8'))) {
          if (matches.length >= limit) {
            truncated = true;
            return;
          }
          matches.push(file);
        }
      } catch {
        // Unreadable / vanished file — skip it.
      }
    }
  }

  const poolSize = Math.min(READ_CONCURRENCY, files.length) || 1;
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return { matches, scanned, truncated };
}
