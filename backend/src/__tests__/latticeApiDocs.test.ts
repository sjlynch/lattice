import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import { canonicalProjectPath } from '../projectPath.js';

// The generated LATTICE_API.md must be usable by an agent in ANY shell — in
// particular cmd.exe, the Windows pty default, where `$LATTICE_API_URL` does
// not expand. That means: bake in the literal API URL + project path, and
// document the cmd.exe `%VAR%` / PowerShell `$env:VAR` syntaxes alongside the
// POSIX `$VAR` form.

async function mkProject(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });
  return dir;
}

test('doc bakes in the literal API URL and canonical project path', async () => {
  const dir = await mkProject('lattice-docs-');
  const docPath = ensureLatticeApiDoc(dir, 5184);
  assert.ok(docPath, 'doc generated when .lattice/ exists');

  const body = await fs.readFile(docPath as string, 'utf8');
  assert.ok(body.includes('http://127.0.0.1:5184'), 'literal API URL present');
  assert.ok(
    body.includes(canonicalProjectPath(dir)),
    'literal canonical project path present (matches $LATTICE_PROJECT)',
  );

  // No placeholder may survive into the rendered doc.
  for (const ph of ['{{API_URL}}', '{{PROJECT}}', '{{API_PORT}}']) {
    assert.ok(!body.includes(ph), `placeholder ${ph} fully interpolated`);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('doc documents cmd.exe (%VAR%) and PowerShell ($env:) syntax, not just $VAR', async () => {
  const dir = await mkProject('lattice-docs-syntax-');
  const body = await fs.readFile(ensureLatticeApiDoc(dir, 5184) as string, 'utf8');

  assert.ok(body.includes('%LATTICE_API_URL%'), 'cmd.exe syntax documented');
  assert.ok(body.includes('$env:LATTICE_API_URL'), 'PowerShell syntax documented');
  assert.ok(body.includes('$LATTICE_API_URL'), 'POSIX syntax still documented');
  // The doc should explicitly warn about the cmd.exe non-expansion trap.
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
