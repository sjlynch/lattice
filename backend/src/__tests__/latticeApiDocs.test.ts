import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import { canonicalProjectPath, projectHash } from '../projectPath.js';

// The generated LATTICE_API.md must be usable by an agent in ANY shell — in
// particular cmd.exe, the Windows pty default, where a `$VAR` reference does
// not expand. Lattice therefore exports NO breadcrumb env vars (nothing read
// them: no harness loads the environment into its context) and every value the
// doc needs is baked in literally instead.

async function mkProject(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });
  return dir;
}

test('doc bakes in the literal API URL, project path, fwd-slash form and hash', async () => {
  const dir = await mkProject('lattice-docs-');
  const docPath = ensureLatticeApiDoc(dir, 5184);
  assert.ok(docPath, 'doc generated when .lattice/ exists');

  const canonical = canonicalProjectPath(dir);
  const body = await fs.readFile(docPath as string, 'utf8');
  assert.ok(body.includes('http://127.0.0.1:5184'), 'literal API URL present');
  assert.ok(body.includes(canonical), 'literal canonical project path present');
  assert.ok(
    body.includes(canonical.replace(/\\/g, '/')),
    'forward-slash project form present (what JSON bodies + shell recipes use)',
  );
  assert.ok(body.includes(projectHash(canonical)), 'literal project hash present');

  // No placeholder may survive into the rendered doc.
  for (const ph of [
    '{{API_URL}}',
    '{{PROJECT}}',
    '{{PROJECT_FWD}}',
    '{{PROJECT_HASH}}',
    '{{API_PORT}}',
  ]) {
    assert.ok(!body.includes(ph), `placeholder ${ph} fully interpolated`);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('the longer {{PROJECT_*}} placeholders are not clipped by {{PROJECT}}', async () => {
  // {{PROJECT}} is a prefix of {{PROJECT_FWD}} / {{PROJECT_HASH}}, so a naive
  // substitution order leaves a mangled `<path>_FWD}}` in the rendered doc.
  const dir = await mkProject('lattice-docs-prefix-');
  const body = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');

  assert.ok(!body.includes('_FWD}}'), 'no clipped _FWD placeholder remnant');
  assert.ok(!body.includes('_HASH}}'), 'no clipped _HASH placeholder remnant');

  await fs.rm(dir, { recursive: true, force: true });
});

test('doc references no shell variables at all (cmd.exe-proof)', async () => {
  const dir = await mkProject('lattice-docs-syntax-');
  const body = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');

  // The breadcrumb env vars are gone. A recipe that still referenced one would
  // silently produce an empty URL or the wrong project.
  for (const re of [/\$(?:env:)?LATTICE_\w+/, /%LATTICE_\w+%/]) {
    assert.ok(!re.test(body), `no ${re} reference survives in the doc`);
  }
  // And it should still warn the reader why it works this way.
  assert.match(body, /cmd\.exe/i);

  await fs.rm(dir, { recursive: true, force: true });
});

test('the literal URL reflects the actual port (drift-proof)', async () => {
  const dir = await mkProject('lattice-docs-port-');
  const body = await fs.readFile(ensureLatticeApiDoc(dir, 6000) as string, 'utf8');

  assert.ok(body.includes('http://127.0.0.1:6000'), 'custom port baked in');
  assert.ok(!body.includes('127.0.0.1:5184'), 'no stale default port leaks in');

  await fs.rm(dir, { recursive: true, force: true });
});

test('doc explains the board concepts an agent may be asked about', async () => {
  // The system-prompt preamble points every harness here for "what is the task
  // board / startup terminals / worktrees" questions, so the answers have to
  // actually be in the file — a pointer to a pure curl cheatsheet would leave
  // an agent in a foreign repo with nothing to say.
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

test('no doc is written when .lattice/ is absent (conservative creation)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-nodocs-'));
  assert.equal(ensureLatticeApiDoc(dir, 5184), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('regeneration is byte-stable for the same inputs (no rewrite churn)', async () => {
  const dir = await mkProject('lattice-docs-stable-');
  const first = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  const second = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');
  assert.equal(first, second, 'second call is byte-identical');
  await fs.rm(dir, { recursive: true, force: true });
});
