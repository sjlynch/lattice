import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexTrustOverride,
  configureCodexProjectTrust,
  LATTICE_CODEX_TRUST_OVERRIDE_ENV,
} from '../terminal/codexTrust.js';

test('buildCodexTrustOverride emits a TOML-safe quoted project key', () => {
  assert.equal(
    buildCodexTrustOverride('C:\\work trees\\a "quoted" repo'),
    'projects."C:\\\\work trees\\\\a \\"quoted\\" repo".trust_level="trusted"',
  );
});

test('cmd Codex launch receives session-local project trust before other flags', () => {
  const env: Record<string, string> = {};
  const command = configureCodexProjectTrust(
    'codex --yolo "do the thing"',
    'C:\\work trees\\repo',
    'C:\\Windows\\System32\\cmd.exe',
    env,
  );

  assert.equal(
    command,
    'codex --config "%LATTICE_CODEX_TRUST_OVERRIDE%" --yolo "do the thing"',
  );
  assert.equal(
    env[LATTICE_CODEX_TRUST_OVERRIDE_ENV],
    'projects."C:\\\\work trees\\\\repo".trust_level="trusted"',
  );
  assert.ok(!command?.includes('work trees'));
});

test('PowerShell Codex launch uses PowerShell environment syntax', () => {
  const env: Record<string, string> = {};
  assert.equal(
    configureCodexProjectTrust('  codex.exe "prompt"', 'C:\\repo', 'pwsh.exe', env),
    '  codex.exe --config "$env:LATTICE_CODEX_TRUST_OVERRIDE" "prompt"',
  );
});

test('POSIX Codex launch uses POSIX environment syntax', () => {
  const env: Record<string, string> = {};
  assert.equal(
    configureCodexProjectTrust('codex "prompt"', '/tmp/a repo', '/bin/zsh', env),
    'codex --config "$LATTICE_CODEX_TRUST_OVERRIDE" "prompt"',
  );
});

test('non-Codex and empty initial commands are untouched', () => {
  const env: Record<string, string> = { KEEP: 'yes' };
  assert.equal(
    configureCodexProjectTrust('claude "prompt"', '/repo', '/bin/bash', env),
    'claude "prompt"',
  );
  assert.equal(configureCodexProjectTrust(undefined, '/repo', '/bin/bash', env), undefined);
  assert.deepEqual(env, { KEEP: 'yes' });
});
