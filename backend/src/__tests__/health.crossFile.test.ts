// Cross-file analysis: import-graph construction, reachability/dead-code
// classification, and entry-point (root) detection. Split out of the original
// monolithic health.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { computeCrossFile, detectRoots } from '../health/index.js';
import { isConventionalRoot } from '../health/crossFile/roots.js';
import type { ParsedAlias } from '../health/tsconfig.js';

// Case-insensitive filesystems (Windows, default macOS) resolve a specifier
// that differs only in case from an on-disk file — the TS/JS runtime does, so
// the resolver must too. The behavior is intentionally platform-specific, so the
// assertions branch on the host platform (the bug only manifests on win32/macOS).
const CASE_INSENSITIVE_HOST =
  process.platform === 'win32' || process.platform === 'darwin';

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

test('case-only import mismatch is not reported dead on case-insensitive FS (regression)', () => {
  // The win32/macOS false-dead bug: src/helper.ts on disk, imported as
  // './Helper.js'. The runtime resolves it, but a verbatim presentFiles.has()
  // missed, dropping the edge → helper.ts read fanIn 0 → flagged DEAD on a
  // machine where it's actually live (and an agent might delete it).
  if (!CASE_INSENSITIVE_HOST) return; // platform-specific; matches the runtime
  const root = path.resolve('health-case-fold-fixture');
  const index = path.join(root, 'src', 'index.ts'); // conventional root
  const helper = path.join(root, 'src', 'helper.ts'); // imported with wrong case
  const present = new Set([index, helper]);
  const roots = detectRoots(present, { projectRoot: root });

  const cross = computeCrossFile(
    [{ filePath: index, imports: ['./Helper.js'] }],
    present,
    undefined,
    { roots },
  );

  assert.equal(cross.fanIn.get(helper), 1, 'case-differing import records the edge');
  assert.equal(cross.deadCode.get(helper), 'live', 'helper is reachable, not dead');
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
    // scripts/ or tools/ nested under src/ is application source, NOT
    // project-level tooling — treating it as a root hides real dead code there.
    'frontend/src/tools/formatDate.ts',
    'src/scripts/analytics.ts',
    'src/tools/legacyExporter.ts',
    'packages/app/src/tools/codegen.ts',
  ]) {
    assert.equal(isConventionalRoot(f), false, `${f} should not be a root`);
  }
});

test('dead code under src/tools/ is reported dead (root heuristic is src-aware)', () => {
  // Regression: the scripts|tools root heuristic used to match the segment
  // ANYWHERE, so a genuinely-unused src/tools file was always classed a live
  // root and could never surface as dead. It must now only auto-root a
  // project-level tooling dir, not one nested under src/.
  const root = path.resolve('health-src-tools-fixture');
  const entry = path.join(root, 'src', 'index.ts'); // conventional root
  const tooling = path.join(root, 'tools', 'codegen.ts'); // top-level tooling → root
  const dead = path.join(root, 'src', 'tools', 'legacyExporter.ts'); // unused app src
  const present = new Set([entry, tooling, dead]);

  const roots = detectRoots(present, { projectRoot: root });
  assert.equal(roots.has(entry), true, 'index.ts is a root');
  assert.equal(roots.has(tooling), true, 'top-level tools/ dir is still a root');
  assert.equal(roots.has(dead), false, 'src/tools/ file is NOT auto-rooted');

  const cross = computeCrossFile(
    [
      { filePath: entry, imports: [] },
      { filePath: tooling, imports: [] },
      { filePath: dead, imports: [] },
    ],
    present,
    undefined,
    { roots },
  );

  assert.equal(cross.deadCode.get(dead), 'dead', 'unused src/tools file → dead');
});
