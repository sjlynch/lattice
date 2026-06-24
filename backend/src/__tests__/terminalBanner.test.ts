import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLatticeBanner } from '../terminalBanner.js';

// Regression guard for the cmd.exe discovery bug: the pty's default shell on
// Windows is cmd.exe, where `$LATTICE_DOCS` is a non-expanding literal. The
// banner must therefore name the doc by its absolute path so the discovery
// hint survives in *any* shell (cmd.exe / PowerShell / POSIX) and for any
// harness — not just a bash-backed one.

test('banner names the doc by its literal path, never $LATTICE_DOCS', () => {
  const docPath = 'C:\\dev\\foo\\.lattice\\LATTICE_API.md';
  const banner = buildLatticeBanner(docPath);

  assert.ok(banner.includes(docPath), 'literal doc path present');
  assert.ok(
    !banner.includes('$LATTICE_DOCS'),
    'must not depend on $LATTICE_DOCS — cmd.exe would not expand it',
  );
});

test('banner keeps the discovery keywords + reference hint', () => {
  const banner = buildLatticeBanner('/home/u/proj/.lattice/LATTICE_API.md');

  for (const kw of ['Lattice', 'tasks', 'taskboard', 'merging', 'worktrees']) {
    assert.ok(banner.includes(kw), `discovery keyword "${kw}" present`);
  }
  assert.match(banner, /API reference at .+LATTICE_API\.md/);
});

test('banner contains no other unexpanded $VAR breadcrumbs', () => {
  const banner = buildLatticeBanner('/tmp/p/.lattice/LATTICE_API.md');
  // A `$LATTICE_…` token anywhere is a cmd.exe footgun. The literal path is
  // the only thing the banner should hand the agent.
  assert.ok(!/\$LATTICE_\w+/.test(banner), 'no $LATTICE_* tokens in the banner');
});
