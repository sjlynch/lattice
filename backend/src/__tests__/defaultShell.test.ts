import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultShell } from '../terminal/launchContext.js';

// Resolution order: LATTICE_DEFAULT_SHELL override → platform default.
// (The per-spawn `opts.shell` override is applied by the caller, above this.)
// These tests inject `env` + `platform` so the cross-platform behavior is
// deterministic regardless of the host the suite runs on.

const WIN_COMSPEC = 'C:\\Windows\\system32\\cmd.exe';

test('LATTICE_DEFAULT_SHELL override wins on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
    const got = resolveDefaultShell(
      { LATTICE_DEFAULT_SHELL: 'pwsh.exe', COMSPEC: WIN_COMSPEC, SHELL: '/bin/bash' },
      platform,
    );
    assert.equal(got, 'pwsh.exe', `override honored on ${platform}`);
  }
});

test('override is trimmed, and a blank/whitespace override is ignored', () => {
  assert.equal(
    resolveDefaultShell({ LATTICE_DEFAULT_SHELL: '  pwsh  ', SHELL: '/bin/zsh' }, 'linux'),
    'pwsh',
  );
  assert.equal(
    resolveDefaultShell({ LATTICE_DEFAULT_SHELL: '   ', SHELL: '/bin/zsh' }, 'linux'),
    '/bin/zsh',
    'whitespace-only override falls through to the platform default',
  );
});

test('windows default is COMSPEC (cmd.exe)', () => {
  assert.equal(resolveDefaultShell({ COMSPEC: WIN_COMSPEC }, 'win32'), WIN_COMSPEC);
});

test('windows falls back to literal cmd.exe when COMSPEC is unset — never powershell', () => {
  // Regression guard: the old code was `process.env.COMSPEC || 'powershell.exe'`.
  // COMSPEC is effectively always set on Windows, so that fallback was dead
  // code; if it is ever absent we want cmd.exe, not a surprise powershell.
  const got = resolveDefaultShell({}, 'win32');
  assert.equal(got, 'cmd.exe');
  assert.notEqual(got, 'powershell.exe');
});

test('posix default is $SHELL, else bash', () => {
  assert.equal(resolveDefaultShell({ SHELL: '/usr/bin/fish' }, 'linux'), '/usr/bin/fish');
  assert.equal(resolveDefaultShell({}, 'darwin'), 'bash');
});
