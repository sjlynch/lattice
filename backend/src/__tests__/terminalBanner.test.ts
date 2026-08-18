import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLatticeBanner } from '../terminalBanner.js';

// The banner is HUMAN-facing chrome: it lands in the session scrollback, which
// only the browser replays, so no harness ever reads it (agents are pointed at
// the doc by harnessSystemPrompts/latticePreamble.ts instead). What it still has
// to do is tell the *user* where this project's reference lives, in a form they
// can paste into any shell — the pty default on Windows is cmd.exe, where a
// `$VAR` reference is a non-expanding literal.

test('banner names the doc by its literal absolute path', () => {
  const docPath = 'C:\\dev\\foo\\.lattice\\LATTICE_API.md';
  const banner = buildLatticeBanner(docPath);

  assert.ok(banner.includes(docPath), 'literal doc path present');
  assert.match(banner, /\[Lattice\]/, 'tagged so it reads as Lattice chrome');
});

test('banner says what the doc is about', () => {
  const banner = buildLatticeBanner('/home/u/proj/.lattice/LATTICE_API.md');

  for (const kw of ['Task board', 'merging', 'worktree']) {
    assert.ok(banner.includes(kw), `subject "${kw}" named`);
  }
  assert.match(banner, /.+LATTICE_API\.md/);
});

test('banner contains no shell-variable references', () => {
  const banner = buildLatticeBanner('/tmp/p/.lattice/LATTICE_API.md');
  // Lattice no longer exports LATTICE_* breadcrumbs into the pty at all (no
  // harness read them), and a `$VAR` token would be a cmd.exe footgun for the
  // user besides. The literal path is the only thing the banner hands over.
  assert.ok(!/\$(?:env:)?LATTICE_\w+/.test(banner), 'no $LATTICE_* tokens');
  assert.ok(!/%LATTICE_\w+%/.test(banner), 'no %LATTICE_*% tokens');
});
