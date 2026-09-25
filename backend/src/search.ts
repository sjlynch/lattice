// Content search across a project's source files. Backs `GET /api/search`
// (routes/search.ts), which the graph's search bar calls (debounced) to
// select every file whose *contents* match the query. Filename matching is
// done client-side off the already-loaded graph; this module is only the
// file-contents pass.
//
// Reuses the same gitignore + source-file collection the scanner uses, so the
// absolute paths returned here are byte-identical to the graph's file-node ids
// (a file node's `id` is its absolute path — see scanner/graphAggregate.ts).
//
// SECURITY — the query is a user-supplied regex (regex=1) or a wildcard glob,
// and it runs against every source file. A raw regex with catastrophic
// backtracking (`(a+)+$`, or a JS-only lookaround like `(?=(a+)+$)` that
// ripgrep can't compile so we fall to the JS path) would otherwise pin V8 for
// an unbounded time. `/api/search` is a GET (a "safe" method), so a drive-by
// page can even trigger it cross-origin — see rejectDisallowedUnsafeOrigin.
// The JS fallback (search/jsGrepWorker.ts) therefore runs in a WORKER THREAD
// with a wall-clock budget: a single `re.test` can only block the worker's
// thread, and the main thread terminates it on overrun, so the event loop
// never freezes.

import { canonicalProjectPath } from './projectPath.js';
import { resolveRipgrep, searchWithRipgrep } from './ripgrep.js';
import { loadGitignore } from './scanner/ignore.js';
import { collectSourceFiles } from './scanner/collectSourceTree.js';
import { runBoundedJsGrep } from './search/jsGrepWorker.js';

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
  // True if we hit `limit` and stopped collecting, OR the regex budget expired.
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
// Wall-clock ceiling on the JS-fallback grep. Because matching runs in a worker
// thread (not the main event loop), a generous budget can't freeze the server —
// this only caps how long a pathological/slow pattern churns before we give up
// and return whatever it found so far (truncated). Override with
// LATTICE_SEARCH_JS_BUDGET_MS (tests use a small value for speed).
const DEFAULT_JS_GREP_BUDGET_MS = 5000;

function jsGrepBudgetMs(): number {
  const raw = Number(process.env.LATTICE_SEARCH_JS_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_JS_GREP_BUDGET_MS;
}

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
  // Compile up front: validates the pattern (invalid → throws → route 400).
  // The compiled value isn't reused (the JS fallback recompiles inside its
  // worker), but this keeps the fast "bad pattern" rejection on the main thread.
  new RegExp(source, 'i');
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
  if (files.length === 0 || options.isCancelled?.()) {
    return { matches: [], scanned: 0, truncated: false };
  }

  return runBoundedJsGrep(files, {
    source,
    limit,
    maxFileBytes: MAX_FILE_BYTES,
    concurrency: READ_CONCURRENCY,
    budgetMs: jsGrepBudgetMs(),
    isCancelled: options.isCancelled,
  });
}
