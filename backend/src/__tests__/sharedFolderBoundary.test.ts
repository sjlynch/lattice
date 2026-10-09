// backend/src/shared/ is imported by BOTH packages: the frontend bundles its
// runtime modules (Vite) and type-checks everything they — and the type-only
// re-exports in shared/wireTypes.ts — resolve to, without @types/node. So every
// module reachable from shared/ must import only relative paths: no `node:`
// builtins, no npm packages. Pins that boundary for the whole reachable graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const SHARED = path.join(SRC, 'shared');
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
// `import('./x.js')` anywhere: an inline type import (`import('./triage.js').X`
// in a type position) or a dynamic import. The frontend type-checks both, so a
// node-reaching one must fail here, not only in `tsc -b`.
const IMPORT_CALL = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(text: string): string[] {
  return [
    ...[...text.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2]),
    ...[...text.matchAll(IMPORT_CALL)].map((m) => m[1]),
  ];
}

function resolveTs(fromFile: string, spec: string): string {
  const base = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${path.relative(SRC, fromFile)}: cannot resolve ${spec}`);
}

test('every module reachable from shared/ imports only relative, node-free modules', () => {
  const seen = new Set<string>();
  const queue = fs.readdirSync(SHARED).filter((f) => f.endsWith('.ts')).map((f) => path.join(SHARED, f));
  const violations: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const spec of specifiersOf(text)) {
      if (!spec.startsWith('.')) {
        violations.push(`${path.relative(SRC, file)} imports '${spec}'`);
        continue;
      }
      queue.push(resolveTs(file, spec));
    }
  }
  assert.ok(seen.size >= 5, `walked ${seen.size} modules`);
  assert.deepEqual(violations, [], 'shared/ must stay importable by the frontend');
});
