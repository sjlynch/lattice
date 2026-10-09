// A runtime import cycle is harmless only while every use of the imported
// bindings sits inside a function. The day an agent adds top-level code that
// reads one (a constant built from an imported helper, a registration call),
// whichever module of the cycle loads first sees the other half-initialized and
// the process dies at boot with "Cannot access 'X' before initialization" — a
// failure no type-check or unit test of a single module shows. This ratchets
// the cycles to the list below: a new cycle (or a file joining a listed one)
// fails here. Break it — move the shared pure piece into a leaf module, or use
// a dynamic `import()` at the call site — rather than listing it. A listed
// cycle that disappeared must be removed from the list.
//
// Runtime edges follow each package's elision rules: `import type` never
// counts; the backend (no verbatimModuleSyntax) also erases an import whose
// specifiers are all `type`, the frontend (verbatimModuleSyntax) keeps it as a
// bare `import {} from`. Dynamic `import()` is not an edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

// The workflow-run lifecycle's mutual recursion: a failed step spawn errors
// the run, teardown cancels the step sessions and the Run tests step, and the
// Run tests step spawns step sessions.
const KNOWN_CYCLES: string[][] = [
  [
    'backend/src/workflowRuns/runErrored.ts',
    'backend/src/workflowRuns/sessionSpawner.ts',
    'backend/src/workflowRuns/stepSpawner.ts',
    'backend/src/workflowRuns/stopHookGate.ts',
    'backend/src/workflowRuns/teardown.ts',
    'backend/src/workflowRuns/testStep/runTestsStep.ts',
  ],
];

const PACKAGES = [
  { root: 'backend/src', keepsTypeOnlySpecifierImports: false },
  { root: 'frontend/src', keepsTypeOnlySpecifierImports: true },
];

function sourceFiles(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
}

function runtimeSpecifiers(file: string, keepsTypeOnlySpecifierImports: boolean): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const specs: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : null;
      const allTypeSpecifiers = !!clause && !clause.name && !!named && named.elements.length > 0
        && named.elements.every((el) => el.isTypeOnly);
      if (allTypeSpecifiers && !keepsTypeOnlySpecifierImports) continue;
      specs.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.isTypeOnly) continue;
      const named = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause : null;
      if (named && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly)
        && !keepsTypeOnlySpecifierImports) continue;
      specs.push(st.moduleSpecifier.text);
    }
  }
  return specs.filter((s) => s.startsWith('.'));
}

function resolveSpecifier(from: string, spec: string, known: Set<string>): string | null {
  const base = path.resolve(path.dirname(from), spec).replace(/\.js$/, '');
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (known.has(c)) return c;
  }
  return null;
}

function cycleGroups(): string[][] {
  const graph = new Map<string, string[]>();
  for (const pkg of PACKAGES) {
    const files: string[] = [];
    sourceFiles(path.join(REPO, pkg.root), files);
    const known = new Set(files);
    for (const f of files) {
      graph.set(f, runtimeSpecifiers(f, pkg.keepsTypeOnlySpecifierImports)
        .map((s) => resolveSpecifier(f, s, known))
        .filter((r): r is string => r !== null));
    }
  }
  // Tarjan's strongly connected components; a component of 2+ files is a cycle.
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next); low.set(v, next); next++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    let w: string;
    do { w = stack.pop()!; onStack.delete(w); group.push(w); } while (w !== v);
    if (group.length > 1) groups.push(group);
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return groups
    .map((g) => g.map((f) => path.relative(REPO, f).split(path.sep).join('/')).sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}

test('no runtime import cycles beyond the known list', () => {
  const found = cycleGroups().map((g) => g.join(' -> '));
  const known = KNOWN_CYCLES.map((g) => [...g].sort().join(' -> '));
  assert.deepEqual(found.filter((g) => !known.includes(g)), [], 'new import cycle: break it (leaf module or dynamic import()), do not list it');
  assert.deepEqual(known.filter((g) => !found.includes(g)), [], 'a listed cycle is gone: remove it from KNOWN_CYCLES');
});
