// Cross-file analysis: import-graph construction, reachability/dead-code
// classification, and entry-point (root) detection. Split out of the original
// monolithic health.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { computeCrossFile, detectRoots } from '../health/index.js';
import {
  compileEntryGlobs,
  globToRegExp,
  isConventionalRoot,
  matchesEntryGlob,
} from '../health/crossFile/roots.js';
import { classifyDeadCode } from '../health/crossFile/deadCode.js';
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

// --- classifyDeadCode confidence guard -------------------------------------
// The "never paint a whole project red on a resolver blind spot" valve: >70%
// of >=20 resolvable non-root files coming back dead is the fingerprint of a
// dropped-edge bug, not a genuinely dead codebase, so every `dead` is demoted
// to `uncertain`. It gates what agents are told to delete (`/api/health/dead-
// code` + the LATTICE_TASK.md "investigate before deleting" note), so a
// regression here silently green-lights mass deletion.

const GUARD_ROOT = path.resolve('health-dead-guard-fixture');

// Craft a `classifyDeadCode` input triple directly (the functions are pure):
// one conventional root, `liveCount` reachable `.ts` files, `deadCount`
// unreachable ones, plus optional extra files that must not count toward the
// resolvable population.
function guardScenario(deadCount: number, liveCount: number, extras: string[] = []) {
  const entry = path.join(GUARD_ROOT, 'src', 'index.ts');
  const dead = Array.from({ length: deadCount }, (_, i) =>
    path.join(GUARD_ROOT, 'src', `dead${i}.ts`));
  const live = Array.from({ length: liveCount }, (_, i) =>
    path.join(GUARD_ROOT, 'src', `live${i}.ts`));
  const roots = new Set([entry]);
  // computeReachability always seeds the reachable set with the roots.
  const reachable = new Set([entry, ...live]);
  const present = new Set([entry, ...live, ...dead, ...extras]);
  const { deadCode, deadCodeStats } = classifyDeadCode(present, roots, reachable);
  return { entry, dead, live, deadCode, deadCodeStats };
}

test('dead-code guard downgrades every dead file when the dead fraction is implausible', () => {
  const asset = path.join(GUARD_ROOT, 'src', 'styles.css'); // not resolvable
  const { entry, dead, live, deadCode, deadCodeStats } = guardScenario(20, 5, [asset]);

  // 20 unreachable + 5 reachable non-root = 25 resolvable; 20/25 = 0.8 > 0.7.
  assert.equal(deadCodeStats.resolvable, 25, 'reachable non-roots count toward the population');
  assert.equal(deadCodeStats.dead, 20, 'stats keep the PRE-downgrade dead count');
  assert.equal(deadCodeStats.downgraded, true, 'guard trips above 70%');

  for (const f of dead) {
    assert.equal(deadCode.get(f), 'uncertain', `${path.basename(f)} demoted red → grey`);
  }
  assert.equal([...deadCode.values()].includes('dead'), false, 'no file is left confidently dead');
  // The downgrade only rewrites `dead`; every other classification survives.
  assert.equal(deadCode.get(entry), 'entry', 'root stays an entry point');
  for (const f of live) {
    assert.equal(deadCode.get(f), 'live', `${path.basename(f)} stays live`);
  }
  assert.equal(deadCode.get(asset), 'uncertain', 'non-resolvable asset unaffected');
});

test('dead-code guard boundaries: the 20-file floor and the 0.7 fraction are exact', () => {
  // Just under the floor: 19/19 is 100% dead, but too small a sample to tell a
  // resolver gap from a genuinely dead corner of a repo → no downgrade.
  const under = guardScenario(19, 0);
  assert.equal(under.deadCodeStats.resolvable, 19);
  assert.equal(under.deadCodeStats.downgraded, false, 'fewer than 20 files never trips');
  for (const f of under.dead) {
    assert.equal(under.deadCode.get(f), 'dead', 'small sample stays confidently dead');
  }

  // Exactly at the floor, same 100% fraction: the count check is `>=`, so it trips.
  const atFloor = guardScenario(20, 0);
  assert.equal(atFloor.deadCodeStats.resolvable, 20);
  assert.equal(atFloor.deadCodeStats.downgraded, true, '20 files is inclusive');
  for (const f of atFloor.dead) {
    assert.equal(atFloor.deadCode.get(f), 'uncertain', 'downgraded at the floor');
  }

  // Exactly on the fraction: 14 dead of 20 resolvable is 0.7, and the
  // comparison is a strict `>`, so the threshold itself is still "plausible".
  const atFraction = guardScenario(14, 6);
  assert.equal(atFraction.deadCodeStats.resolvable, 20);
  assert.equal(
    atFraction.deadCodeStats.dead / atFraction.deadCodeStats.resolvable,
    0.7,
    'fixture sits exactly on the threshold',
  );
  assert.equal(atFraction.deadCodeStats.downgraded, false, 'exactly 0.7 does not trip');
  for (const f of atFraction.dead) {
    assert.equal(atFraction.deadCode.get(f), 'dead', 'stays confidently dead at 0.7');
  }

  // One file past the line: 15/20 = 0.75.
  const over = guardScenario(15, 5);
  assert.equal(over.deadCodeStats.resolvable, 20);
  assert.equal(over.deadCodeStats.downgraded, true, 'just above 0.7 trips');
  for (const f of over.dead) {
    assert.equal(over.deadCode.get(f), 'uncertain', 'downgraded just above 0.7');
  }
});

test('dead-code guard population excludes roots and non-resolvable files', () => {
  // A pile of assets must not dilute the fraction into "plausible" — the guard
  // only ever reasons about files it could confidently call dead.
  const assets = Array.from({ length: 40 }, (_, i) =>
    path.join(GUARD_ROOT, 'assets', `a${i}.css`));
  const { dead, deadCode, deadCodeStats } = guardScenario(20, 0, assets);

  assert.equal(deadCodeStats.resolvable, 20, 'assets are outside the population');
  assert.equal(deadCodeStats.dead, 20);
  assert.equal(deadCodeStats.downgraded, true, 'assets cannot mask a resolver gap');
  for (const f of dead) assert.equal(deadCode.get(f), 'uncertain');
  for (const f of assets) assert.equal(deadCode.get(f), 'uncertain', 'assets stay uncertain');
});

// --- deadCodeEntryGlobs matcher --------------------------------------------
// The user-configurable whitelist for framework magic (file-based routing, DI
// registries). A bug means a declared entry point never roots reachability, so
// its live files read as `dead` and an agent deletes framework-wired code.

test('globToRegExp: ** crosses directories (including zero), * and ? do not', () => {
  const routes = globToRegExp('src/**/routes/*.ts');
  assert.equal(routes.test('src/routes/a.ts'), true, '** matches zero directories');
  assert.equal(routes.test('src/a/routes/b.ts'), true, '** matches one directory');
  assert.equal(routes.test('src/a/b/c/routes/d.ts'), true, '** matches many directories');
  assert.equal(routes.test('src/a/routes/nested/b.ts'), false, 'the trailing * stays in one segment');

  const leading = globToRegExp('**/*.tsx');
  assert.equal(leading.test('Button.tsx'), true, 'a leading **/ matches a top-level file');
  assert.equal(leading.test('src/ui/Button.tsx'), true, 'and a file at any depth');

  const star = globToRegExp('src/*.ts');
  assert.equal(star.test('src/a.ts'), true);
  assert.equal(star.test('src/sub/a.ts'), false, '* does not cross /');
  assert.equal(star.test('a.ts'), false, 'the pattern is anchored at the start');
  assert.equal(star.test('vendor/src/a.ts'), false, 'no unanchored substring match');
  assert.equal(star.test('src/a.tsx'), false, 'the pattern is anchored at the end');

  const q = globToRegExp('src/page?.ts');
  assert.equal(q.test('src/page1.ts'), true, '? matches exactly one character');
  assert.equal(q.test('src/page.ts'), false, '? is not optional');
  assert.equal(q.test('src/page12.ts'), false, '? is not repeated');
  assert.equal(q.test('src/page/.ts'), false, '? does not cross /');
});

test('globToRegExp: regex metacharacters are literal, not operators', () => {
  const dot = globToRegExp('src/app.config.ts');
  assert.equal(dot.test('src/app.config.ts'), true);
  assert.equal(dot.test('src/appxconfigxts'), false, '. is a literal dot, not "any char"');

  const meta = globToRegExp('src/(a|b)+[x]{2}^$.ts');
  assert.equal(meta.test('src/(a|b)+[x]{2}^$.ts'), true, 'metachars match themselves');
  assert.equal(meta.test('src/a.ts'), false, 'no alternation group');
  assert.equal(meta.test('src/(a|b)[x]{2}^$.ts'), false, '+ is literal, not a repeat');
  assert.equal(meta.test('src/(a|b)+x{2}^$.ts'), false, '[] is literal, not a char class');

  // The backslash branch: globs are matched against a forward-slashed relative
  // path, so a Windows-style glob is a literal-backslash pattern that matches
  // nothing real (rather than `\a` silently degrading into a bare `a`).
  const backslash = globToRegExp('src\\a.ts');
  assert.equal(backslash.test('src\\a.ts'), true, 'a backslash is escaped to a literal');
  assert.equal(backslash.test('src/a.ts'), false, 'globs must be written with /');
  assert.equal(backslash.test('srca.ts'), false, 'the backslash is not dropped');
});

test('matchesEntryGlob matches project-relative paths and refuses root escapes', () => {
  const root = path.resolve('health-entry-glob-fixture');
  const regexps = compileEntryGlobs(['src/pages/**/*.tsx', 'app/routes.ts']);

  assert.equal(
    matchesEntryGlob(path.join(root, 'src', 'pages', 'Home.tsx'), root, regexps),
    true,
    'the OS-separator path is normalized to / before matching',
  );
  assert.equal(
    matchesEntryGlob(path.join(root, 'src', 'pages', 'admin', 'Users.tsx'), root, regexps),
    true,
    '** spans nested route directories',
  );
  assert.equal(
    matchesEntryGlob(path.join(root, 'app', 'routes.ts'), root, regexps),
    true,
    'any glob in the list may match',
  );
  assert.equal(
    matchesEntryGlob(path.join(root, 'src', 'pages', 'Home.ts'), root, regexps),
    false,
    'a non-matching file is not rooted',
  );
  assert.equal(
    matchesEntryGlob(path.join(root, 'src', 'pages', 'Home.tsx'), root, []),
    false,
    'no configured globs → nothing is rooted',
  );
  assert.equal(
    matchesEntryGlob(
      path.join(root, 'src', 'pages', 'Home.tsx'),
      root,
      compileEntryGlobs(['pages/*.tsx']),
    ),
    false,
    'globs anchor at the project root, not at any path suffix',
  );

  // Outside the project root: the relative path escapes with `..`, so the
  // globs must not be consulted at all — a sibling checkout's file is not this
  // project's entry point.
  assert.equal(
    matchesEntryGlob(
      path.resolve(root, '..', 'other-project', 'src', 'pages', 'Home.tsx'),
      root,
      regexps,
    ),
    false,
    'a sibling directory is rejected',
  );
  assert.equal(
    matchesEntryGlob(
      path.resolve(root, 'src', '..', '..', 'evil', 'src', 'pages', 'X.tsx'),
      root,
      regexps,
    ),
    false,
    'traversing back out of the root is rejected',
  );
  assert.equal(
    matchesEntryGlob(
      path.join(`${root}-backup`, 'src', 'pages', 'Home.tsx'),
      root,
      regexps,
    ),
    false,
    'a sibling that merely shares the root prefix is rejected',
  );
  assert.equal(
    matchesEntryGlob(root, root, compileEntryGlobs(['**'])),
    false,
    'the project root itself has an empty relative path and never matches',
  );
});
