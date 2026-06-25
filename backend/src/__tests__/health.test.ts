import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { analyzeFile, computeCrossFile, detectRoots } from '../health/index.js';
import { isConventionalRoot } from '../health/crossFile/roots.js';
import { resolveImport } from '../health/crossFile/resolveImport.js';
import { cyclicNodes, tarjan } from '../health/crossFile/cycles.js';
import type { HealthMetrics } from '../health/index.js';
import type { ParsedAlias } from '../health/tsconfig.js';
import type { CacheEntry } from '../health/cache.js';
import { hydrateWatcherState } from '../health/watcher/cacheHydration.js';

function smellCount(metrics: HealthMetrics, id: string): number {
  return metrics.smells.find((s) => s.id === id)?.count ?? 0;
}

function minimalMetrics(overrides: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    score: 100,
    language: 'typescript',
    loc: 1,
    commentRatio: 0,
    cyclomaticMax: 1,
    cyclomaticTotal: 1,
    cognitiveMax: 0,
    cognitiveTotal: 0,
    maxNestingDepth: 0,
    halstead: {
      vocabulary: 0,
      length: 0,
      volume: 0,
      difficulty: 0,
      effort: 0,
    },
    maintainabilityIndex: 100,
    functionCount: 0,
    namedFunctionCount: 0,
    avgFunctionLength: 0,
    maxFunctionLength: 0,
    maxParamCount: 0,
    classCount: 0,
    callGraphDensity: 0,
    godFunctionRatio: 0,
    smells: [],
    smellCount: 0,
    ...overrides,
  };
}

// A switch with N cases used to cost N*(1+nesting) cognitive points
// because every switch_case fired the cognitive penalty. The Sonar
// B1 spec says the switch dispatches once with the nesting penalty
// and individual cases add nothing, so this same source should now
// land at a small constant regardless of case count.
test('cognitive complexity does not blow up on switch with many cases', async () => {
  const src = `
function dispatch(x: string): number {
  switch (x) {
    case 'a': return 1;
    case 'b': return 2;
    case 'c': return 3;
    case 'd': return 4;
    case 'e': return 5;
    case 'f': return 6;
    case 'g': return 7;
    default: return 0;
  }
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.ts', loc);
  // Pre-fix: ~8 (one per case at nesting 0). Post-fix: 1 (the
  // switch_statement itself). Allow some slack but assert it's
  // well under the high_cognitive_complexity threshold of 15.
  assert.ok(
    r.metrics.cognitiveMax <= 3,
    `expected cognitiveMax <= 3, got ${r.metrics.cognitiveMax}`,
  );
  // Cyclomatic still counts each case as a path — that part is
  // unchanged and a switch with 8 cases legitimately has 8+ paths.
  assert.ok(
    r.metrics.cyclomaticMax >= 7,
    `expected cyclomaticMax >= 7, got ${r.metrics.cyclomaticMax}`,
  );
});

test('Go file is analyzed via tree-sitter, not fallback', async () => {
  const src = `package main

import "fmt"

func add(a int, b int) int {
  if a > b {
    return a + b
  }
  return b + a
}

func main() {
  fmt.Println(add(1, 2))
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.go', loc);
  assert.equal(r.metrics.language, 'go');
  // Two named functions, both detected.
  assert.equal(r.metrics.functionCount, 2);
  assert.equal(r.metrics.namedFunctionCount, 2);
  // The if branch should bump cyclomatic for `add` past 1.
  assert.ok(r.metrics.cyclomaticMax >= 2);
});

test('Rust file: match expression contributes to cognitive once', async () => {
  const src = `fn classify(x: i32) -> &'static str {
  match x {
    0 => "zero",
    1 => "one",
    2 => "two",
    _ => "other",
  }
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.rs', loc);
  assert.equal(r.metrics.language, 'rust');
  assert.equal(r.metrics.functionCount, 1);
  // Cognitive: just the match dispatch itself. Pre-fix-style
  // accidentally-overcounting Rust would give us 4+.
  assert.ok(
    r.metrics.cognitiveMax <= 2,
    `expected cognitiveMax <= 2, got ${r.metrics.cognitiveMax}`,
  );
  // McCabe paths: 4 arms.
  assert.ok(r.metrics.cyclomaticMax >= 4);
});

test('Java method declaration is recognized', async () => {
  const src = `
public class Foo {
  public int add(int a, int b) {
    if (a > b) {
      return a + b;
    }
    return b + a;
  }
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.java', loc);
  assert.equal(r.metrics.language, 'java');
  assert.ok(r.metrics.functionCount >= 1);
  assert.ok(r.metrics.classCount >= 1);
});

test('files at fallback path still report language=fallback', async () => {
  const r = await analyzeFile('echo hello', '.sh', 1);
  assert.equal(r.metrics.language, 'fallback');
});

// Pre-fix, an `else if` chain charged +1+nesting at each successive
// arm, so a 4-arm router cost 1+2+3+4=10 cognitive points (failing the
// high_cognitive_complexity threshold of 15 once a fifth arm landed).
// Sonar B1: else-if is a continuation — +1 only, no nesting bump.
test('else-if chains do not over-penalize cognitive complexity', async () => {
  const src = `
function route(x: string): number {
  if (x === 'a') return 1;
  else if (x === 'b') return 2;
  else if (x === 'c') return 3;
  else if (x === 'd') return 4;
  else return 0;
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.ts', loc);
  // Sonar's expected total: 1 + 1 + 1 + 1 = 4 cognitive points for the
  // chain itself. Allow a little slack for any short-circuit detection
  // in the comparisons but assert it stays well under 15.
  assert.ok(
    r.metrics.cognitiveMax <= 6,
    `expected cognitiveMax <= 6, got ${r.metrics.cognitiveMax}`,
  );
  // McCabe still counts each arm as a path — 4 arms + base = 5+.
  assert.ok(
    r.metrics.cyclomaticMax >= 5,
    `expected cyclomaticMax >= 5, got ${r.metrics.cyclomaticMax}`,
  );
  // Nesting depth should be 1 (the chain lives at the original `if`'s
  // depth), not 4.
  assert.equal(
    r.metrics.maxNestingDepth,
    1,
    `expected maxNestingDepth 1, got ${r.metrics.maxNestingDepth}`,
  );
});

// Magic-string detection used to slurp every string literal regardless
// of context. Files with several imports of the same module would
// accumulate the path to the magic-string threshold and trip the smell
// for what is really just shared module routing.
test('magic_string ignores import path strings', async () => {
  const src = `
import a from './shared/utils';
import b from './shared/utils';
import c from './shared/utils';
import d from './shared/utils';
function f() { return a; }
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.ts', loc);
  const magicString = r.metrics.smells.find((s) => s.id === 'magic_string');
  assert.equal(
    magicString,
    undefined,
    `expected no magic_string smell on import paths, got ${magicString?.count}`,
  );
});

// Pre-fix the `mixed_exports` smell counted top-level export
// *statements*, so a single `export { a, b, c, d, e, f, g }` next to a
// `export default ...` never triggered. Now we count actual bindings.
test('mixed_exports counts bindings, not statements', async () => {
  const src = `
export const a = 1;
export const b = 2;
export const c = 3;
export const d = 4;
export const e = 5;
export const f = 6;
export default function main() { return 0; }
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.ts', loc);
  const mixed = r.metrics.smells.find((s) => s.id === 'mixed_exports');
  assert.ok(mixed && mixed.count >= 1, 'expected mixed_exports to fire');

  // Same number of bindings, same default — single export-clause form.
  const compact = `
export { a, b, c, d, e, f };
export default function main() { return 0; }
const a = 1, b = 2, c = 3, d = 4, e = 5, f = 6;
`;
  const compactR = await analyzeFile(compact, '.ts', compact.split('\n').length);
  const compactMixed = compactR.metrics.smells.find((s) => s.id === 'mixed_exports');
  assert.ok(
    compactMixed && compactMixed.count >= 1,
    'expected mixed_exports to fire on compact export-clause form too',
  );
});

// `def f(x: bool = True)` is the most common Python boolean param,
// missed entirely by the original code which only checked
// `default_parameter` and `typed_parameter`.
test('Python typed_default_parameter boolean is detected', async () => {
  const src = `
def configure(verbose: bool = True, debug: bool = False, path: str = "x"):
    pass
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.py', loc);
  const boolParam = r.metrics.smells.find((s) => s.id === 'boolean_param');
  assert.ok(
    boolParam && boolParam.count >= 2,
    `expected boolean_param >= 2, got ${boolParam?.count ?? 0}`,
  );
});

// `Object.foo = () => {}` should be NAMED (`foo`), not anonymous.
test('arrow-function name is recovered from member-expression LHS', async () => {
  const src = `
const obj = {};
obj.handle = (n: number) => n + 1;
function caller() { return obj.handle(2); }
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.ts', loc);
  // `caller` (named) plus `handle` (now also named) → both should count
  // as named.
  assert.ok(
    r.metrics.namedFunctionCount >= 2,
    `expected namedFunctionCount >= 2, got ${r.metrics.namedFunctionCount}`,
  );
});

// console.error / warn used to fire `console_log`; only log/debug/info/
// trace/dir/table do now.
test('console.error and console.warn are not flagged', async () => {
  const src = `
function fails(e: unknown) {
  console.error('boom', e);
  console.warn('careful');
  console.log('hi');
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.ts', loc);
  const consoleSmell = r.metrics.smells.find((s) => s.id === 'console_log');
  assert.equal(
    consoleSmell?.count,
    1,
    `expected exactly one console_log (log only), got ${consoleSmell?.count ?? 0}`,
  );
});

// Ruby `do_block` / `block` used to be treated as separate functions,
// inflating functionCount and resetting nesting in the middle of a
// method. Now they're nesting kinds attributed to the enclosing method.
test('Ruby blocks are nesting, not separate functions', async () => {
  const src = `
class Foo
  def each_double(arr)
    arr.each do |x|
      arr.each do |y|
        puts x * y
      end
    end
  end
end
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.rb', loc);
  assert.equal(r.metrics.language, 'ruby');
  // Just the method itself — blocks no longer count as functions.
  assert.equal(
    r.metrics.functionCount,
    1,
    `expected functionCount 1, got ${r.metrics.functionCount}`,
  );
  // Nested blocks should accumulate nesting depth on the method.
  assert.ok(
    r.metrics.maxNestingDepth >= 2,
    `expected maxNestingDepth >= 2, got ${r.metrics.maxNestingDepth}`,
  );
});

// Java classic `switch (x) { case A: ... }` was missing from the
// cognitive set so a routine dispatch had cognitive 0.
test('Java classic switch_statement contributes to cognitive', async () => {
  const src = `
public class Dispatcher {
  public int route(String x) {
    switch (x) {
      case "a": return 1;
      case "b": return 2;
      case "c": return 3;
      default: return 0;
    }
  }
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.java', loc);
  assert.equal(r.metrics.language, 'java');
  // Pre-fix: 0. Post-fix: at least 1 (the switch dispatch itself).
  assert.ok(
    r.metrics.cognitiveMax >= 1,
    `expected cognitiveMax >= 1, got ${r.metrics.cognitiveMax}`,
  );
});

test('cross-file analysis resolves aliases, Python relatives, duplicates, and self loops', () => {
  const root = path.resolve('health-cross-file-fixture');
  const app = path.join(root, 'src', 'app.ts');
  const util = path.join(root, 'src', 'util.ts');
  const pyMain = path.join(root, 'pkg', 'mod', 'main.py');
  const pyHelper = path.join(root, 'pkg', 'shared', 'helper.py');
  const self = path.join(root, 'src', 'self.ts');
  const present = new Set([app, util, pyMain, pyHelper, self]);
  const aliases: ParsedAlias[] = [
    { prefix: '@/', isWildcard: true, substitutions: [path.join(root, 'src')] },
  ];

  const cross = computeCrossFile([
    { filePath: app, imports: ['@/util', './util', './util.ts'] },
    { filePath: pyMain, imports: ['..shared.helper'] },
    { filePath: self, imports: ['./self'] },
  ], present, aliases);

  assert.equal(cross.fanOut.get(app), 1, 'duplicate imports should de-dupe');
  assert.equal(cross.fanIn.get(util), 1, 'alias and relative specs land once');
  assert.equal(cross.fanOut.get(pyMain), 1, 'Python relative import resolves');
  assert.equal(cross.fanIn.get(pyHelper), 1, 'Python helper receives fan-in');
  assert.equal(cross.fanOut.get(self), 0, 'self imports do not inflate fan-out');
  assert.equal(cross.fanIn.get(self), 0, 'self imports do not inflate fan-in');
  assert.equal(cross.inCycle.has(self), true, 'self import is marked cyclic');
});

// Regression: the original recursive Tarjan recursed once per edge along the
// deepest DFS path, so call depth == longest simple import chain. A long linear
// chain (a -> b -> ... -> zN) thousands of files deep threw `RangeError:
// Maximum call stack size exceeded`. The iterative form keeps frames on the
// heap and must complete cleanly on a chain far deeper than the JS call stack.
test('Tarjan cycle detection scales to a deep import chain without stack overflow', () => {
  const N = 20000;
  const nodes: string[] = [];
  const edges = new Map<string, Set<string>>();
  for (let i = 0; i < N; i++) {
    const file = `f${i}.ts`;
    nodes.push(file);
    // Each file imports the next; the last imports nothing — a pure acyclic chain.
    edges.set(file, new Set(i + 1 < N ? [`f${i + 1}.ts`] : []));
  }

  const sccs = tarjan(nodes, edges);
  // An acyclic chain has one singleton SCC per node and no cycles.
  assert.equal(sccs.length, N, 'one SCC per node in an acyclic chain');
  assert.equal(cyclicNodes(sccs, edges).size, 0, 'no node is in a cycle');
});

// Same depth, but the chain closes into a ring (cN-1 -> c0) so the whole thing
// is one strongly-connected component. Exercises the deep descent AND the
// SCC-collapse that happens on the unwind/return side.
test('Tarjan detects one giant cycle across a deep chain', () => {
  const N = 20000;
  const nodes: string[] = [];
  const edges = new Map<string, Set<string>>();
  for (let i = 0; i < N; i++) {
    const file = `c${i}.ts`;
    nodes.push(file);
    edges.set(file, new Set([`c${(i + 1) % N}.ts`]));
  }

  const sccs = tarjan(nodes, edges);
  assert.equal(cyclicNodes(sccs, edges).size, N, 'every node in the ring is cyclic');
  const big = sccs.filter((s) => s.length > 1);
  assert.equal(big.length, 1, 'the entire ring collapses into a single SCC');
  assert.equal(big[0].length, N, 'and that SCC spans every node');
});

test('resolver maps NodeNext .js specifiers to their TS sources', () => {
  const root = path.resolve('resolve-nodenext-fixture');
  const caller = path.join(root, 'caller.ts');
  const a = path.join(root, 'a.ts');
  const b = path.join(root, 'b.tsx');
  const m = path.join(root, 'm.mts');
  const c = path.join(root, 'c.cts');
  const present = new Set([caller, a, b, m, c]);

  assert.equal(resolveImport(caller, './a.js', present), a, '.js → .ts');
  assert.equal(resolveImport(caller, './b.js', present), b, '.js → .tsx');
  assert.equal(resolveImport(caller, './m.mjs', present), m, '.mjs → .mts');
  assert.equal(resolveImport(caller, './c.cjs', present), c, '.cjs → .cts');
});

test('resolver prefers a real .js sibling over the .ts remap', () => {
  const root = path.resolve('resolve-jsts-fixture');
  const caller = path.join(root, 'caller.ts');
  const js = path.join(root, 'x.js');
  const ts = path.join(root, 'x.ts');
  const present = new Set([caller, js, ts]);
  assert.equal(resolveImport(caller, './x.js', present), js, 'exact .js wins');
});

test('baseUrl catch-all resolves bare imports but never relative ones', () => {
  const root = path.resolve('resolve-baseurl-fixture');
  const baseDir = path.join(root, 'src');
  const foo = path.join(baseDir, 'foo.ts');
  const baseTypes = path.join(baseDir, 'types.ts');
  const relTypes = path.join(root, 'pages', 'types.ts');
  const caller = path.join(root, 'pages', 'caller.ts');
  const present = new Set([foo, baseTypes, relTypes, caller]);
  const aliases: ParsedAlias[] = [
    { prefix: '', isWildcard: true, substitutions: [baseDir] },
  ];

  assert.equal(resolveImport(caller, 'foo', present, aliases), foo, 'bare → baseUrl');
  assert.equal(
    resolveImport(caller, './types', present, aliases),
    relTypes,
    'relative resolves next to the importer, not baseUrl',
  );
  assert.equal(
    resolveImport(caller, 'react', present, aliases),
    null,
    'unresolvable bare specifier is still external',
  );
});

test('import extraction captures re-exports and dynamic import/require', async () => {
  const src = `
import { a } from './static';
export { b } from './reexport';
export * from './star';
const x = await import('./dynamic');
const y = require('./required');
const z = import(variablePath); // computed — not resolvable, skipped
`;
  const r = await analyzeFile(src, '.ts', src.split('\n').length);
  assert.ok(r.imports.includes('./static'), 'plain import captured');
  assert.ok(r.imports.includes('./reexport'), 'named re-export source captured');
  assert.ok(r.imports.includes('./star'), 'star re-export source captured');
  assert.ok(r.imports.includes('./dynamic'), 'dynamic import() captured');
  assert.ok(r.imports.includes('./required'), 'require() captured');
});

test('dead-code reachability flags orphans, dead islands, and entry points', () => {
  const root = path.resolve('health-dead-code-fixture');
  const entry = path.join(root, 'src', 'index.ts'); // conventional root
  const live = path.join(root, 'src', 'live.ts'); // imported by entry
  const barrel = path.join(root, 'src', 'barrel.ts'); // reached via re-export
  const lazy = path.join(root, 'src', 'lazy.ts'); // reached via dynamic import
  const orphan = path.join(root, 'src', 'orphan.ts'); // nothing imports it
  const islandA = path.join(root, 'src', 'islandA.ts'); // dead pair, import
  const islandB = path.join(root, 'src', 'islandB.ts'); //  each other only
  const asset = path.join(root, 'src', 'styles.css'); // unreachable, no grammar
  const present = new Set([entry, live, barrel, lazy, orphan, islandA, islandB, asset]);

  const roots = detectRoots(present, { projectRoot: root });
  assert.equal(roots.has(entry), true, 'index.ts is a conventional root');

  const cross = computeCrossFile(
    [
      { filePath: entry, imports: ['./live', './barrel', './lazy'] },
      { filePath: barrel, imports: [] },
      { filePath: live, imports: [] },
      { filePath: lazy, imports: [] },
      { filePath: orphan, imports: [] },
      { filePath: islandA, imports: ['./islandB'] },
      { filePath: islandB, imports: ['./islandA'] },
    ],
    present,
    undefined,
    { roots },
  );

  assert.equal(cross.deadCode.get(entry), 'entry', 'root → entry');
  assert.equal(cross.deadCode.get(live), 'live', 'imported file → live');
  assert.equal(cross.deadCode.get(barrel), 'live', 're-exported file → live');
  assert.equal(cross.deadCode.get(lazy), 'live', 'dynamically imported → live');
  assert.equal(cross.deadCode.get(orphan), 'dead', 'unimported TS file → dead');
  assert.equal(cross.deadCode.get(islandA), 'dead', 'dead island is unreachable');
  assert.equal(cross.deadCode.get(islandB), 'dead', 'fan-in>0 but still dead');
  assert.equal(
    cross.deadCode.get(asset),
    'uncertain',
    'unreachable non-code asset is uncertain, never dead',
  );
});

test('unreachable .mjs/.cjs are uncertain, not dead (fs-loaded assets)', () => {
  const root = path.resolve('health-mjs-cjs-fixture');
  const index = path.join(root, 'src', 'index.ts');
  const tmpl = path.join(root, 'src', 'template.cjs'); // read via fs, not imported
  const script = path.join(root, 'src', 'helper.mjs'); // standalone, unimported
  const orphanTs = path.join(root, 'src', 'orphan.ts');
  const present = new Set([index, tmpl, script, orphanTs]);
  const roots = detectRoots(present, { projectRoot: root });

  const cross = computeCrossFile(
    [{ filePath: index, imports: [] }],
    present,
    undefined,
    { roots },
  );

  assert.equal(cross.deadCode.get(tmpl), 'uncertain', '.cjs never confidently dead');
  assert.equal(cross.deadCode.get(script), 'uncertain', '.mjs never confidently dead');
  assert.equal(cross.deadCode.get(orphanTs), 'dead', '.ts orphan still flagged dead');
});

test('reachability connects NodeNext .js-specifier imports (regression)', () => {
  // The dominant false-dead bug: a TS project whose imports carry `.js`
  // specifiers (`import './util.js'`) pointing at `.ts` files. Before the
  // resolver remap every such edge dropped and the whole tree read as dead.
  const root = path.resolve('health-nodenext-fixture');
  const index = path.join(root, 'src', 'index.ts'); // root
  const util = path.join(root, 'src', 'util.ts');
  const deep = path.join(root, 'src', 'deep.ts');
  const present = new Set([index, util, deep]);
  const roots = detectRoots(present, { projectRoot: root });

  const cross = computeCrossFile(
    [
      { filePath: index, imports: ['./util.js'] },
      { filePath: util, imports: ['./deep.js'] },
    ],
    present,
    undefined,
    { roots },
  );

  assert.equal(cross.fanIn.get(util), 1, '.js specifier resolves to util.ts');
  assert.equal(cross.deadCode.get(util), 'live', 'util reachable via .js import');
  assert.equal(cross.deadCode.get(deep), 'live', 'transitively reachable too');
  assert.equal(cross.deadCodeStats?.downgraded, false, 'no resolver-gap guard trip');
});

test('conventional root detection covers entries, configs, tests, and decls', () => {
  for (const f of [
    'src/index.ts',
    'frontend/src/main.tsx',
    'backend/server.ts',
    'backend/src/terminal-server.ts', // -server suffix (spawned by path)
    'backend/src/foo.worker.ts', // .worker suffix
    'backend/scripts/dev.mjs', // under a scripts/ dir
    'scripts/orchestrate.mjs',
    'tools/codegen.ts',
    'vite.config.ts',
    'jest.config.js',
    'src/foo.test.ts',
    'src/__tests__/bar.ts',
    'types/global.d.ts',
  ]) {
    assert.equal(isConventionalRoot(f), true, `${f} should be a root`);
  }
  for (const f of [
    'src/util.ts',
    'src/components/Button.tsx',
    'lib/helper.py',
    'src/observer.ts', // not a -server/-worker suffix
  ]) {
    assert.equal(isConventionalRoot(f), false, `${f} should not be a root`);
  }
});

test('watcher cache hydration keeps imports and metrics mirrors aligned', () => {
  const filePath = path.resolve('health-watch-cache', 'a.ts');
  const metrics = minimalMetrics({ loc: 12, fanIn: 3, fanOut: 1 });
  const entry: CacheEntry = { mtimeMs: 1, size: 2, metrics, imports: ['./b'] };
  const cache = {
    *entries(): IterableIterator<[string, CacheEntry]> {
      yield [filePath, entry];
    },
  };

  const hydrated = hydrateWatcherState(cache);
  assert.deepEqual(hydrated.imports.get(filePath), ['./b']);
  assert.equal(hydrated.metrics.get(filePath), metrics);
});

test('TS any/type assertion/non-null smells are preserved', async () => {
  const src = `
function f(value: any) {
  const name = value as string;
  return name!.length;
}
`;
  const r = await analyzeFile(src, '.ts', src.split('\n').length);
  assert.equal(smellCount(r.metrics, 'any_type'), 1);
  assert.equal(smellCount(r.metrics, 'type_assertion'), 1);
  assert.equal(smellCount(r.metrics, 'non_null_assertion'), 1);
});

test('TS required and optional boolean parameters are counted', async () => {
  const src = `
function flags(required: boolean, optional?: boolean, name?: string) {
  return required && !!optional && !!name;
}
`;
  const r = await analyzeFile(src, '.ts', src.split('\n').length);
  assert.equal(r.metrics.maxParamCount, 3);
  assert.equal(smellCount(r.metrics, 'boolean_param'), 2);
});

test('Python default parameters drive boolean and mutable-default smells', async () => {
  const src = `
def configure(enabled=True, debug=False, items=[], options: dict = {}):
    pass
`;
  const r = await analyzeFile(src, '.py', src.split('\n').length);
  assert.equal(smellCount(r.metrics, 'boolean_param'), 2);
  assert.equal(smellCount(r.metrics, 'mutable_default_arg'), 2);
});

test('Python bare except and global statement smells are preserved', async () => {
  const src = `
def update():
    global state
    try:
        state = 1
    except:
        pass
`;
  const r = await analyzeFile(src, '.py', src.split('\n').length);
  assert.equal(smellCount(r.metrics, 'bare_except'), 1);
  assert.equal(smellCount(r.metrics, 'global_keyword'), 1);
});

test('Python docstring detection still suppresses only documented public functions', async () => {
  const src = `
def documented():
    """docs"""
    return 1

def undocumented():
    return 2

def _private():
    return 3
`;
  const r = await analyzeFile(src, '.py', src.split('\n').length);
  assert.equal(smellCount(r.metrics, 'missing_docstring'), 1);
});

test('deep optional chains and nested ternaries are preserved', async () => {
  const src = `
function f(a: any, b: boolean, c: boolean, d: boolean) {
  const chain = a?.b?.c?.d?.e?.f;
  return b ? (c ? (d ? 1 : 2) : 3) : 4;
}
`;
  const r = await analyzeFile(src, '.ts', src.split('\n').length);
  assert.equal(smellCount(r.metrics, 'deep_optional_chain'), 1);
  assert.equal(smellCount(r.metrics, 'deep_ternary'), 1);
});

test('aggregate threshold smells are preserved', async () => {
  const manyFunctions = Array.from(
    { length: 21 },
    (_, i) => `function f${i}() { return ${i}; }`,
  ).join('\n');
  const src = `
${manyFunctions}
function tooMany(a: number, b: number, c: number, d: number, e: number, f: number) {
  return a + b + c + d + e + f;
}
class First {}
class Second {}
`;
  const r = await analyzeFile(src, '.ts', src.split('\n').length);
  assert.equal(smellCount(r.metrics, 'high_function_count'), 1);
  assert.equal(smellCount(r.metrics, 'long_param_list'), 1);
  assert.equal(smellCount(r.metrics, 'multiple_classes'), 1);
});
