// Import resolver unit tests. Exercises the focused modules behind the
// `resolveImport.ts` re-export shim: extension/index candidates + NodeNext
// .js→.ts remap (extensionCandidates), the case-folded filesystem index
// (caseFold), Python relative-import translation (pythonImports), and tsconfig
// alias resolution (aliasResolution). Split out of the original health.test.ts;
// the new direct-helper tests pin the module boundaries introduced by the split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  INDEX_FILES,
  RESOLVE_EXTS,
  normalizePythonRelativeImport,
  resolveByAlias,
  resolveImport,
  tryAllExtensions,
} from '../health/crossFile/resolveImport.js';
import type { ParsedAlias } from '../health/tsconfig.js';

const CASE_INSENSITIVE_HOST =
  process.platform === 'win32' || process.platform === 'darwin';

// ---- resolveImport orchestrator ----

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

test('resolver resolves a directory import to its index file', () => {
  const root = path.resolve('resolve-dir-index-fixture');
  const caller = path.join(root, 'caller.ts');
  const idx = path.join(root, 'widgets', 'index.ts');
  const present = new Set([caller, idx]);
  assert.equal(resolveImport(caller, './widgets', present), idx, 'directory → index.ts');
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

test('resolver matches a case-differing specifier on case-insensitive filesystems', () => {
  const root = path.resolve('resolve-case-fold-fixture');
  const caller = path.join(root, 'caller.ts');
  const helper = path.join(root, 'helper.ts'); // lowercase on disk
  const present = new Set([caller, helper]);

  // `import './Helper.js'` (wrong case + NodeNext .js twin) → helper.ts.
  const resolvedExt = resolveImport(caller, './Helper.js', present);
  // `import './HELPER'` (wrong case, extensionless) → helper.ts.
  const resolvedBare = resolveImport(caller, './HELPER', present);

  if (CASE_INSENSITIVE_HOST) {
    assert.equal(resolvedExt, helper, 'case-differing .js specifier folds to helper.ts');
    assert.equal(resolvedBare, helper, 'case-differing extensionless specifier folds too');
  } else {
    assert.equal(resolvedExt, null, 'case-sensitive FS keeps the exact-case miss');
    assert.equal(resolvedBare, null, 'case-sensitive FS keeps the exact-case miss');
  }
});

test('resolver returns null for an empty spec or a bare external package', () => {
  const root = path.resolve('resolve-null-fixture');
  const caller = path.join(root, 'caller.ts');
  const present = new Set([caller]);
  assert.equal(resolveImport(caller, '', present), null, 'empty spec');
  assert.equal(resolveImport(caller, 'lodash/fp', present), null, 'external package');
  assert.equal(resolveImport(caller, './missing', present), null, 'unresolved relative');
});

// ---- tryAllExtensions: the extension/index candidate core ----

test('tryAllExtensions appends source extensions for an extensionless target', () => {
  const root = path.resolve('resolve-extless-fixture');
  const mod = path.join(root, 'mod.ts');
  const data = path.join(root, 'data.json');
  const present = new Set([mod, data]);
  assert.equal(tryAllExtensions(path.join(root, 'mod'), present), mod, 'extensionless → .ts');
  assert.equal(tryAllExtensions(path.join(root, 'data'), present), data, 'extensionless → .json');
  assert.equal(tryAllExtensions(path.join(root, 'nope'), present), null, 'no candidate → null');
  // The candidate sets the resolver consults are the documented source surface.
  assert.ok(RESOLVE_EXTS.includes('.ts') && RESOLVE_EXTS.includes('.py'));
  assert.ok(INDEX_FILES.includes('index.ts') && INDEX_FILES.includes('__init__.py'));
});

test('tryAllExtensions resolves a directory target to each index variant', () => {
  const root = path.resolve('resolve-index-variants-fixture');
  const tsIndex = path.join(root, 'ts-pkg', 'index.ts');
  const pyInit = path.join(root, 'py-pkg', '__init__.py');
  const present = new Set([tsIndex, pyInit]);
  assert.equal(tryAllExtensions(path.join(root, 'ts-pkg'), present), tsIndex, 'dir → index.ts');
  assert.equal(tryAllExtensions(path.join(root, 'py-pkg'), present), pyInit, 'dir → __init__.py');
});

// ---- normalizePythonRelativeImport: leading-dot translation ----

test('normalizePythonRelativeImport translates leading-dot specs to fs-relative', () => {
  assert.equal(normalizePythonRelativeImport('.foo'), './foo', 'one dot → current package');
  assert.equal(normalizePythonRelativeImport('..foo.bar'), '../foo/bar', 'two dots → parent');
  assert.equal(normalizePythonRelativeImport('...pkg.mod'), '../../pkg/mod', 'three dots → grandparent');
  assert.equal(normalizePythonRelativeImport('os.path'), 'os.path', 'absolute (no leading dot) untouched');
});

// ---- resolveByAlias: tsconfig path aliases ----

test('resolveByAlias resolves non-wildcard exact and wildcard prefix aliases', () => {
  const root = path.resolve('resolve-alias-fixture');
  const api = path.join(root, 'lib', 'api.ts');
  const util = path.join(root, 'lib', 'util.ts');
  const present = new Set([api, util]);
  const aliases: ParsedAlias[] = [
    { prefix: '@app', isWildcard: false, substitutions: [path.join(root, 'lib', 'api')] },
    { prefix: '~/', isWildcard: true, substitutions: [path.join(root, 'lib')] },
  ];
  assert.equal(resolveByAlias('@app', aliases, present), api, 'exact alias → file');
  assert.equal(resolveByAlias('~/util', aliases, present), util, 'wildcard alias → file');
  assert.equal(resolveByAlias('~/missing', aliases, present), null, 'unresolved alias tail → null');
  assert.equal(resolveByAlias('@other', aliases, present), null, 'non-matching spec → null');
});

// ---- Python absolute imports ----

// Bare Python specs were treated like npm packages and dropped, so a codebase
// importing by package path (`from app.models import User`) had almost no
// edges and its modules read as dead.
test('resolveImport resolves absolute Python imports against the importer ancestors', () => {
  const root = path.resolve('resolve-python-abs-fixture');
  const main = path.join(root, 'app', 'main.py');
  const models = path.join(root, 'app', 'models.py');
  const pkgInit = path.join(root, 'app', 'services', '__init__.py');
  const stub = path.join(root, 'app', 'typed.pyi');
  const present = new Set([main, models, pkgInit, stub]);

  assert.equal(resolveImport(main, 'app.models', present), models, 'root-relative dotted module');
  assert.equal(resolveImport(main, 'app.services', present), pkgInit, 'package → __init__.py');
  assert.equal(resolveImport(main, 'app.typed', present), stub, 'stub-only module → .pyi');
  assert.equal(resolveImport(main, 'models', present), models, 'script-dir sibling (sys.path[0])');
  assert.equal(resolveImport(main, 'os', present), null, 'stdlib / site-packages stays unresolved');
  assert.equal(resolveImport(main, 'app..models', present), null, 'malformed dotted spec');
  // A TS importer's bare spec is still an npm package, never a Python module.
  assert.equal(resolveImport(path.join(root, 'web.ts'), 'app.models', present), null);
});
