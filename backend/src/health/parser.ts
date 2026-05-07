// Tree-sitter runtime + grammar loader. The runtime initializes once
// per process; grammars load lazily on first use and are then cached
// for the lifetime of the process. Each call to `getParser(ext)` hands
// back a parser pre-configured with the matching language so callers
// can immediately .parse() without thinking about init state.
//
// We use the `web-tree-sitter` (WASM) bindings rather than the native
// build because Lattice ships to Windows users who often don't have
// node-gyp / Visual Studio Build Tools installed. WASM is ~3–5× slower
// than native but plenty fast for incremental file analysis (~10–15k
// LoC/sec) and trivially cross-platform.

import path from 'node:path';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

// We resolve packages by walking up from this module's location
// looking for `node_modules/<pkg>`. This is more robust than
// `require.resolve` for packages whose `exports` field doesn't
// expose internal paths or `package.json` directly (which is the
// case for both `web-tree-sitter` and `tree-sitter-wasms`).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findPackageDir(packageName: string): string {
  let cur = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(cur, 'node_modules', packageName);
    try {
      if (fsSync.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`Could not locate ${packageName} via node_modules walk from ${__dirname}`);
}

// Map our file extensions to the wasm grammars shipped by
// `@vscode/tree-sitter-wasm`. Extensions outside this map fall back
// to the universal text-based analyzer. We use VSCode's bundle
// instead of `tree-sitter-wasms` because the latter ships grammars
// built against an older ABI that's incompatible with current
// `web-tree-sitter` runtimes.
const GRAMMAR_BY_EXT: Record<string, string> = {
  '.ts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-tsx.wasm',
  '.js': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript.wasm',
  '.mjs': 'tree-sitter-javascript.wasm',
  '.cjs': 'tree-sitter-javascript.wasm',
  '.py': 'tree-sitter-python.wasm',
  '.pyi': 'tree-sitter-python.wasm',
};

export type GrammarKey = 'typescript' | 'tsx' | 'javascript' | 'python';

export function grammarKeyForExt(ext: string): GrammarKey | null {
  switch (ext) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    default:
      return null;
  }
}

// Resolve the path to the `tree-sitter-wasms` package's `out/` folder
// at runtime. The package layout is stable: `node_modules/tree-sitter-
// wasms/out/tree-sitter-<lang>.wasm`. We look up via require.resolve so
// the project still works in monorepo / pnpm hoisting scenarios.
function resolveGrammarPath(filename: string): string {
  return path.join(findPackageDir('@vscode/tree-sitter-wasm'), 'wasm', filename);
}

let runtimeReady: Promise<void> | null = null;
const grammarCache = new Map<string, Promise<Language>>();

function ensureRuntime(): Promise<void> {
  if (runtimeReady) return runtimeReady;
  runtimeReady = Parser.init({
    // Tell Emscripten where the runtime .wasm lives. Without this it
    // tries `web-tree-sitter.wasm` relative to the cwd at parse time
    // and fails when Lattice is started from anywhere except the
    // backend dir.
    locateFile: (file: string) => path.join(findPackageDir('web-tree-sitter'), file),
  });
  return runtimeReady;
}

async function loadGrammar(ext: string): Promise<Language | null> {
  const wasmFile = GRAMMAR_BY_EXT[ext];
  if (!wasmFile) return null;
  let entry = grammarCache.get(wasmFile);
  if (!entry) {
    entry = (async () => {
      await ensureRuntime();
      const wasmPath = resolveGrammarPath(wasmFile);
      return Language.load(wasmPath);
    })();
    grammarCache.set(wasmFile, entry);
  }
  return entry;
}

// Pool of one Parser per grammar. JavaScript is single-threaded and
// `Parser.parse` is synchronous, so a single shared instance per
// language is safe and avoids the WASM allocation/teardown cost of
// `new Parser()` for every analyzed file. Tested empirically: on a
// 1k-file TS project this drops per-scan parser overhead from ~600ms
// to ~30ms.
const parserPool = new Map<GrammarKey, Parser>();

// Get a parser ready for the given extension. Returns null for any
// extension that isn't a recognised grammar — the caller should fall
// back to text-only analysis. The returned parser is shared; the
// caller MUST NOT call `.delete()` on it (do that only at process
// teardown via `disposePool`).
export async function getParser(ext: string): Promise<{
  parser: Parser;
  language: Language;
  key: GrammarKey;
} | null> {
  const key = grammarKeyForExt(ext);
  if (!key) return null;
  const language = await loadGrammar(ext);
  if (!language) return null;
  let parser = parserPool.get(key);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserPool.set(key, parser);
  }
  return { parser, language, key };
}

// Drop the cached parsers — only call at process teardown or in tests.
export function disposePool(): void {
  for (const p of parserPool.values()) {
    try {
      p.delete();
    } catch {
      /* ignore */
    }
  }
  parserPool.clear();
}

// Pre-warm a grammar (used by the file watcher to avoid a first-edit
// spike when a project is opened).
export async function preloadGrammar(ext: string): Promise<void> {
  await loadGrammar(ext);
}

// Reset for tests.
export function _resetForTest(): void {
  runtimeReady = null;
  grammarCache.clear();
  disposePool();
}
