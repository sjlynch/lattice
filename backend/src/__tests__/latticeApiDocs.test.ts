import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureLatticeApiDoc,
  LATTICE_API_RECIPES_DOC_FILENAME,
} from '../latticeApiDocs.js';
import { canonicalProjectPath, projectHash } from '../projectPath.js';

// The generated LATTICE_API.md must be usable by an agent in ANY shell — in
// particular cmd.exe, the Windows pty default, where a `$VAR` reference does
// not expand. Lattice therefore exports NO breadcrumb env vars (nothing read
// them: no harness loads the environment into its context) and every value the
// doc needs is baked in literally instead.
//
// Since 2026-09 there are TWO generated files: the SHORT index the
// system-prompt preamble names (read whole on every Lattice question) and the
// recipes file it points at (read only on demand). Both are covered here.

async function mkProject(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });
  return dir;
}

function recipesPathFor(dir: string): string {
  return path.join(dir, '.lattice', LATTICE_API_RECIPES_DOC_FILENAME);
}

test('doc bakes in the literal API URL, project path, fwd-slash form and hash', async () => {
  const dir = await mkProject('lattice-docs-');
  const docPath = ensureLatticeApiDoc(dir, 5184);
  assert.ok(docPath, 'doc generated when .lattice/ exists');

  const canonical = canonicalProjectPath(dir);
  const recipes = await fs.readFile(recipesPathFor(dir), 'utf8');
  for (const body of [await fs.readFile(docPath as string, 'utf8'), recipes]) {
    assert.ok(body.includes('http://127.0.0.1:5184'), 'literal API URL present');
    assert.ok(body.includes(canonical), 'literal canonical project path present');
    assert.ok(
      body.includes(canonical.replace(/\\/g, '/')),
      'forward-slash project form present (what JSON bodies + shell recipes use)',
    );
    assert.ok(body.includes(projectHash(canonical)), 'literal project hash present');

    // No placeholder may survive into a rendered doc.
    for (const ph of [
      '{{API_URL}}',
      '{{PROJECT}}',
      '{{PROJECT_FWD}}',
      '{{PROJECT_HASH}}',
      '{{API_PORT}}',
      '{{RECIPES_PATH}}',
    ]) {
      assert.ok(!body.includes(ph), `placeholder ${ph} fully interpolated`);
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('the index points at the recipes file by absolute path', async () => {
  // The pointer is the whole progressive-disclosure mechanism: an agent that
  // needs the endpoint table has to be able to open the file directly, without
  // resolving a relative hint against a cwd that is usually a worktree.
  const dir = await mkProject('lattice-docs-pointer-');
  const index = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  const recipesPath = path.join(
    canonicalProjectPath(dir),
    '.lattice',
    LATTICE_API_RECIPES_DOC_FILENAME,
  );

  assert.ok(index.includes(recipesPath), 'index names the recipes file absolutely');
  await fs.stat(recipesPathFor(dir)); // throws if it wasn't written

  await fs.rm(dir, { recursive: true, force: true });
});

test('the longer {{PROJECT_*}} placeholders are not clipped by {{PROJECT}}', async () => {
  // {{PROJECT}} is a prefix of {{PROJECT_FWD}} / {{PROJECT_HASH}}, so a naive
  // substitution order leaves a mangled `<path>_FWD}}` in the rendered doc.
  const dir = await mkProject('lattice-docs-prefix-');
  const index = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  const recipes = await fs.readFile(recipesPathFor(dir), 'utf8');

  for (const body of [index, recipes]) {
    assert.ok(!body.includes('_FWD}}'), 'no clipped _FWD placeholder remnant');
    assert.ok(!body.includes('_HASH}}'), 'no clipped _HASH placeholder remnant');
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('neither doc references a shell variable (cmd.exe-proof)', async () => {
  const dir = await mkProject('lattice-docs-syntax-');
  const index = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  const recipes = await fs.readFile(recipesPathFor(dir), 'utf8');

  // The breadcrumb env vars are gone. A recipe that still referenced one would
  // silently produce an empty URL or the wrong project.
  for (const body of [index, recipes]) {
    for (const re of [/\$(?:env:)?LATTICE_\w+/, /%LATTICE_\w+%/]) {
      assert.ok(!re.test(body), `no ${re} reference survives in the doc`);
    }
  }
  // And the index should still warn the reader why it works this way.
  assert.match(index, /cmd\.exe/i);

  await fs.rm(dir, { recursive: true, force: true });
});

test('the literal URL reflects the actual port (drift-proof)', async () => {
  const dir = await mkProject('lattice-docs-port-');
  const index = await fs.readFile(ensureLatticeApiDoc(dir, 6000) as string, 'utf8');
  const recipes = await fs.readFile(recipesPathFor(dir), 'utf8');

  for (const body of [index, recipes]) {
    assert.ok(body.includes('http://127.0.0.1:6000'), 'custom port baked in');
    assert.ok(!body.includes('127.0.0.1:5184'), 'no stale default port leaks in');
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('doc explains the board concepts an agent may be asked about', async () => {
  // The system-prompt preamble points every harness at the INDEX for "what is
  // the task board / startup terminals / worktrees" questions, so the answers
  // have to be in that file — pushing them into the recipes file would leave an
  // agent in a foreign repo with nothing to say without a second read.
  const dir = await mkProject('lattice-docs-concepts-');
  const body = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');

  for (const concept of [
    'Task board',
    'Ready to Merge',
    'Worktrees',
    'Workflows',
    'Startup terminals',
  ]) {
    assert.ok(body.includes(concept), `concept "${concept}" documented`);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('the index teaches the cheap-first read path', async () => {
  // The reason the split exists: the old single doc's first list recipe was an
  // unfiltered GET /api/tasks, which on a real board is ~1.2 MB / ~320k tokens.
  const dir = await mkProject('lattice-docs-tiers-');
  const body = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');

  assert.match(body, /cheapest first/i, 'the tier table is present');
  for (const marker of [
    '/api/tasks/summary',
    '/api/tasks/search',
    'approxTokens',
    'hint',
    'confirm_large',
    'fields=compact',
  ]) {
    assert.ok(body.includes(marker), `index mentions ${marker}`);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('the index stays small enough to read on every question — even for a long project path', async () => {
  // This file is named by the system-prompt preamble, so an agent reads it
  // WHOLE every time it is asked anything about Lattice. It was 19 KB (~5k
  // tokens) before the split; the budget is what stops it silently regrowing.
  // Anything that needs more room belongs in LATTICE_API_RECIPES.md.
  //
  // The project path is interpolated ~8 times, so the rendered size grows with
  // it: measure against a deliberately LONG path (a short temp dir would pass a
  // template that a real nested checkout blows through).
  const dir = await mkProject('lat-size-');
  const long = path.join(dir, 'a-deliberately-long-nested-project-directory-name-for-the-budget-test');
  await fs.mkdir(path.join(long, '.lattice'), { recursive: true });
  assert.ok(long.length >= 80, `test path is ${long.length} chars; needs to be long to be meaningful`);
  const body = await fs.readFile(ensureLatticeApiDoc(long, 5184) as string, 'utf8');

  assert.ok(
    Buffer.byteLength(body, 'utf8') < 5120,
    `LATTICE_API.md is ${Buffer.byteLength(body, 'utf8')} bytes for an ${long.length}-char ` +
      'project path — over the 5 KB budget. Move the new material into ' +
      'LATTICE_API_RECIPES.template.md instead of growing the index every agent reads in full.',
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('no doc is written when .lattice/ is absent (conservative creation)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-nodocs-'));
  assert.equal(ensureLatticeApiDoc(dir, 5184), null);
  assert.equal(
    await fs.readdir(dir).then((entries) => entries.length),
    0,
    'not even the recipes file is seeded into a non-Lattice folder',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('regeneration is byte-stable for the same inputs (no rewrite churn)', async () => {
  const dir = await mkProject('lattice-docs-stable-');
  const firstIndex = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  const firstRecipes = await fs.readFile(recipesPathFor(dir), 'utf8');
  const secondIndex = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  const secondRecipes = await fs.readFile(recipesPathFor(dir), 'utf8');

  assert.equal(firstIndex, secondIndex, 'index: second call is byte-identical');
  assert.equal(firstRecipes, secondRecipes, 'recipes: second call is byte-identical');
  // Both carry their OWN version stamp, so editing one template rewrites only
  // that file.
  for (const body of [firstIndex, firstRecipes]) {
    assert.match(body, /^<!-- lattice-docs-version: [0-9a-f]{12} -->\n/);
  }
  assert.notEqual(
    firstIndex.split('\n', 1)[0],
    firstRecipes.split('\n', 1)[0],
    'the two files hash their own content, not a shared stamp',
  );

  await fs.rm(dir, { recursive: true, force: true });
});

// Regression: `replaceAll(placeholder, value)` interprets `$$` / `$&` in the
// value, so a project path containing them was written into the docs wrong.
test('a project path containing `$` patterns is written verbatim', async () => {
  const dir = await mkProject('lattice-docs-$$x$&y-');
  const canonical = canonicalProjectPath(dir);
  assert.ok(canonical.includes('$$x$&y'), 'fixture path keeps its `$` patterns');
  const index = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  assert.ok(index.includes(canonical), 'the literal path, not a `$`-expanded one');
  const recipes = await fs.readFile(recipesPathFor(dir), 'utf8');
  assert.ok(recipes.includes(canonical));
});
