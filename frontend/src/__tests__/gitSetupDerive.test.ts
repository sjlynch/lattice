import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  describeProbeBlocker,
  deriveGitChipState,
  formatBytes,
  formatFileCount,
  hasLargeEntry,
  LARGE_ENTRY_BYTES,
} from '../components/gitSetup/gitSetupDerive.ts';
import type { ProjectGitProbe } from '../api/types/git.ts';

// gitSetupDerive is the pure core of the Git Setup feature: the navbar chip's
// state machine, the copy for every non-initializable probe, and the number
// formatting the preview dialog renders. The chip table below mirrors the
// backend/frontend contract, so these assertions ARE that table.

function probe(p: Partial<ProjectGitProbe> & { state: ProjectGitProbe['state'] }): ProjectGitProbe {
  return { initable: false, ...p };
}

test('basename takes the last segment across separators and trailing slashes', () => {
  assert.equal(basename('C:\\development\\lattice'), 'lattice');
  assert.equal(basename('C:/development/lattice/'), 'lattice');
  assert.equal(basename('/home/me/projects/app'), 'app');
  // A drive root has no segment to take — return what we were given.
  assert.equal(basename('C:\\'), 'C:');
});

test('no probe falls back to the pre-feature branch chip (never guesses No Git)', () => {
  // Loading, a failed fetch, or a backend that predates the contract. Showing
  // "No Git" there would be a lie on every normal repo during the first paint.
  assert.deepEqual(deriveGitChipState(null, 'main'), {
    kind: 'branch',
    label: 'main',
    title: 'Current git branch: main',
  });
  assert.equal(deriveGitChipState(null, null), null);
  assert.equal(deriveGitChipState(undefined, null), null);
});

test('repo renders the branch chip, or nothing until the branch arrives', () => {
  const p = probe({ state: 'repo', toplevel: 'C:/development/lattice' });
  assert.deepEqual(deriveGitChipState(p, 'main'), {
    kind: 'branch',
    label: 'main',
    title: 'Current git branch: main',
  });
  assert.equal(deriveGitChipState(p, null), null);
});

test('none + initable is the only clickable state, labelled with a verb', () => {
  const chip = deriveGitChipState(probe({ state: 'none', initable: true }), null);
  assert.equal(chip?.kind, 'action');
  // A verb is an invitation; a bare status ("No Git") is a dead end.
  assert.equal(chip?.label, 'Set up Git');
  assert.match(chip!.title, /not a git repository yet/i);
});

test('none without initable is inert and explains itself via the probe reason', () => {
  const chip = deriveGitChipState(
    probe({ state: 'none', initable: false, reason: 'Refusing to init your home directory.' }),
    null,
  );
  assert.deepEqual(chip, {
    kind: 'info',
    tone: 'muted',
    label: 'No Git',
    title: 'Refusing to init your home directory.',
  });
});

test('nested names the parent repo and is never offered as an action', () => {
  const chip = deriveGitChipState(
    probe({ state: 'nested', toplevel: 'C:/development/monorepo' }),
    null,
  );
  assert.equal(chip?.kind, 'info');
  assert.equal(chip?.kind === 'info' && chip.tone, 'warning');
  assert.equal(chip?.label, 'inside monorepo');
  // The title has to say what Lattice will DO, not just what it found.
  assert.match(chip!.title, /Lattice will use the parent repository at C:\/development\/monorepo\./);
});

test('nested without a toplevel still renders a chip', () => {
  const chip = deriveGitChipState(probe({ state: 'nested' }), null);
  assert.equal(chip?.label, 'inside a repo');
});

test('bare / unavailable / error all render an inert No Git chip', () => {
  for (const state of ['bare', 'unavailable', 'error'] as const) {
    const chip = deriveGitChipState(probe({ state }), 'main');
    assert.equal(chip?.kind, 'info', state);
    assert.equal(chip?.label, 'No Git', state);
    // A stale branch must not leak through for a folder we can't read.
    assert.notEqual(chip?.label, 'main');
    // Default reason when the backend didn't send one — never an empty tooltip.
    assert.ok((chip?.title.length ?? 0) > 0, state);
  }
});

test('a backend-supplied reason wins over the built-in default', () => {
  const chip = deriveGitChipState(
    probe({ state: 'error', reason: 'EACCES reading .git' }),
    null,
  );
  assert.equal(chip?.title, 'EACCES reading .git');
});

test('describeProbeBlocker refuses nested explicitly and points at the parent', () => {
  const { title, lines } = describeProbeBlocker(
    probe({ state: 'nested', toplevel: '/repos/monorepo' }),
  );
  assert.match(title, /already inside a git repository/i);
  assert.ok(lines.some((l) => l.includes('/repos/monorepo')));
  // The whole point: init is not on offer here, and the copy says why.
  assert.ok(lines.some((l) => /nest it inside/i.test(l)));
});

test('describeProbeBlocker tells an unavailable git how to become available', () => {
  const { title, lines } = describeProbeBlocker(probe({ state: 'unavailable' }));
  assert.match(title, /not available/i);
  assert.ok(lines.some((l) => /PATH/.test(l)));
});

test('formatBytes scales units and keeps one decimal above bytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.0 GB');
  // Clamps at the largest unit rather than inventing one.
  assert.equal(formatBytes(3 * 1024 ** 4), '3.0 TB');
  assert.equal(formatBytes(3 * 1024 ** 5), '3072.0 TB');
});

test('formatFileCount groups thousands and marks a truncated walk as a floor', () => {
  assert.equal(formatFileCount(7, false), '7');
  assert.equal(formatFileCount(20000, false), '20,000');
  // `truncated` means the backend stopped counting — say "at least this many".
  assert.equal(formatFileCount(20000, true), '20,000+');
  assert.equal(formatFileCount(0, false), '0');
  assert.equal(formatFileCount(Number.NaN, false), '0');
});

test('hasLargeEntry only fires once something is worth worrying about', () => {
  assert.equal(hasLargeEntry([]), false);
  assert.equal(hasLargeEntry([{ bytes: 1024 }, { bytes: 4096 }]), false);
  assert.equal(hasLargeEntry([{ bytes: LARGE_ENTRY_BYTES }]), true);
  assert.equal(hasLargeEntry([{ bytes: 10 }, { bytes: 40 * 1024 * 1024 }]), true);
});
