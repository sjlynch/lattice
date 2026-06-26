import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINGERPRINT_FILES } from '../terminalFingerprint.js';

// The terminal-server fingerprint is the staleness detector: a byte change to
// any module in the running server's import graph must change the digest so a
// freshly-spawned backend never reuses a stale orphan that still serves the
// OLD behavior (probeServer treats a fingerprint match as "ok" and reuses the
// running server). This test enforces that contract STRUCTURALLY — it walks
// terminal-server.js's static import graph from source and fails if any
// reachable runtime module is absent from FINGERPRINT_FILES. It is what would
// have caught terminalConfig.js / ids.js / projectPath.js (terminal tunables,
// the session-id scheme, the project-path breadcrumbs) and parentWatch.js
// being silently omitted.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..');

// terminalFingerprint.js is the hasher, not a hashed input — listing it would
// be circular, and a logic change that alters the digest is self-detecting
// (the new backend computes a different "expected" than the orphan advertised,
// so a respawn already fires without it being in the list). It is therefore an
// intentional non-entry, not an omission.
const HASHER = 'terminalFingerprint.js';

/** Static relative import/export specifiers in a source file, skipping
 *  type-only `import type` / `export type` statements (erased at compile, so
 *  they load no runtime bytes). */
function relativeImportSpecifiers(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const specs: string[] = [];
  // `import ... from '<spec>'`, `export ... from '<spec>'`, and bare
  // `import '<spec>'`. Captures the keyword so we can drop `type`-only ones.
  const re =
    /\b(import|export)\b(\s+type\b)?[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2]) continue; // `import type` / `export type` — no runtime load
    const spec = m[3] ?? m[4];
    if (spec && spec.startsWith('.')) specs.push(spec);
  }
  return specs;
}

/** Resolve a `.js`-suffixed relative specifier to its on-disk `.ts` source. */
function resolveToTs(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base.endsWith('.js') ? base.slice(0, -3) + '.ts' : null,
    base + '.ts',
    path.join(base, 'index.ts'),
  ].filter((c): c is string => c !== null);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null; // external pkg or non-TS asset (e.g. a read-at-runtime .md)
}

/** Transitive closure of `.ts` modules reachable from terminal-server.ts via
 *  static relative imports, expressed as `.js` paths relative to src/. */
function terminalServerGraph(): string[] {
  const start = path.join(SRC, 'terminal-server.ts');
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const file = path.normalize(queue.shift()!);
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of relativeImportSpecifiers(file)) {
      const resolved = resolveToTs(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen].map((f) =>
    path.relative(SRC, f).split(path.sep).join('/').replace(/\.ts$/, '.js'),
  );
}

test('every module in terminal-server.js import graph is fingerprinted', () => {
  const listed = new Set(FINGERPRINT_FILES);
  const missing = terminalServerGraph()
    .filter((mod) => mod !== HASHER)
    .filter((mod) => !listed.has(mod))
    .sort();

  assert.deepEqual(
    missing,
    [],
    `terminal-server runtime modules missing from FINGERPRINT_FILES (a byte ` +
      `change to these would NOT respawn a stale orphan): ${missing.join(', ')}`,
  );
});

test('the omitted terminal tunable/helper modules are now fingerprinted', () => {
  // The specific regression: these are imported by terminal/createSession,
  // scrollbackStore, sessionLifecycle, and launchContext, so an edit to a
  // terminal tunable must invalidate a running orphan.
  for (const mod of ['terminalConfig.js', 'ids.js', 'projectPath.js']) {
    assert.ok(
      FINGERPRINT_FILES.includes(mod),
      `${mod} must be in FINGERPRINT_FILES`,
    );
  }
});

test('FINGERPRINT_FILES has no duplicate entries', () => {
  assert.equal(
    FINGERPRINT_FILES.length,
    new Set(FINGERPRINT_FILES).size,
    'duplicate fingerprint entries hash the same bytes twice for no benefit',
  );
});
