// LATTICE_HOME relocates every home-scoped path (a second instance keeps the
// real HOME for harness auth); unset, it is ~/.lattice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { latticeHomeDir } from '../latticeHome.js';
import { homeProjectDir, terminalScrollbackDir } from '../projectPath.js';

function withLatticeHome<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.LATTICE_HOME;
  if (value === undefined) delete process.env.LATTICE_HOME;
  else process.env.LATTICE_HOME = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.LATTICE_HOME;
    else process.env.LATTICE_HOME = saved;
  }
}

test('defaults to ~/.lattice; blank counts as unset', () => {
  const expected = path.join(os.homedir(), '.lattice');
  assert.equal(withLatticeHome(undefined, latticeHomeDir), expected);
  assert.equal(withLatticeHome('   ', latticeHomeDir), expected);
});

test('LATTICE_HOME is resolved and used by the derived paths', () => {
  const root = path.join(os.tmpdir(), 'lattice-home-override');
  withLatticeHome(root, () => {
    assert.equal(latticeHomeDir(), path.resolve(root));
    assert.equal(terminalScrollbackDir(), path.join(path.resolve(root), 'terminal-scrollback'));
    assert.ok(homeProjectDir(os.tmpdir()).startsWith(path.join(path.resolve(root), 'per-project') + path.sep));
  });
});
