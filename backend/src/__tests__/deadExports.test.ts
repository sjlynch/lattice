// Dead exports accumulate silently in an agent-maintained codebase: a feature
// moves on, its helper stays exported "for later", and every future agent pays
// to read and reason about it (24 such exports were removed in one pass). This
// fails on an export of backend/src or frontend/src whose name appears in no
// other file — tests, scripts and e2e included — and nowhere else in its own
// file. A test-only export (a seam) is fine: a test references it. Delete the
// export rather than allowlisting it; allowlist only a deliberate public entry
// point nothing in-repo imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_ROOTS = ['backend/src', 'frontend/src'];
const REFERENCE_ROOTS = ['backend/src', 'backend/scripts', 'frontend/src', 'scripts', 'e2e'];
const ALLOWLIST = new Set<string>([]);

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
}

test('no export is referenced by nothing at all', () => {
  const files: string[] = [];
  for (const r of REFERENCE_ROOTS) walk(path.join(REPO, r), files);
  const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const filesWithToken = new Map<string, number>();
  for (const s of text.values()) {
    for (const t of new Set(s.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])) {
      filesWithToken.set(t, (filesWithToken.get(t) ?? 0) + 1);
    }
  }
  const declaration =
    /^export\s+(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  const dead: string[] = [];
  for (const [file, s] of text) {
    const rel = path.relative(REPO, file).replace(/\\/g, '/');
    if (!SOURCE_ROOTS.some((r) => rel.startsWith(`${r}/`)) || rel.includes('/__tests__/')) continue;
    for (const m of s.matchAll(declaration)) {
      const name = m[1];
      if (ALLOWLIST.has(`${rel}:${name}`) || (filesWithToken.get(name) ?? 0) > 1) continue;
      const ownUses = s.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'))?.length ?? 0;
      if (ownUses <= 1) dead.push(`${rel}: ${name}`);
    }
  }
  assert.ok(text.size > 500, `scanned ${text.size} files`);
  assert.deepEqual(dead, [], 'exported but referenced nowhere — delete it');
});
