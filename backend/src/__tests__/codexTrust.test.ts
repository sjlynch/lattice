import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexTrustOverride,
  configureCodexProjectTrust,
  configureCodexProjectMcp,
  codexMcpOverrideEnv,
  LATTICE_CODEX_TRUST_OVERRIDE_ENV,
} from '../terminal/codexTrust.js';

// Regression: the override used to be `projects."<JSON cwd>".trust_level=…`.
// Codex (verified on codex-cli 0.157) splits a `-c` KEY on every `.` and keeps
// quote characters in the segment, so no quoted dotted key ever matched — and
// cmd's `"%VAR%"` strips inner double quotes, so on Windows the path lost its
// quotes, kept JSON-doubled backslashes, and a space split it into a stray
// argument that broke the launch. The path is now an inline-table key inside
// the (real-TOML) VALUE, as a single-quoted literal.
test('buildCodexTrustOverride puts the cwd in an inline-table literal key', () => {
  assert.equal(
    buildCodexTrustOverride('C:\\work trees\\.lattice\\repo'),
    "projects={'C:\\work trees\\.lattice\\repo'={trust_level='trusted'}}",
  );
  assert.equal(
    buildCodexTrustOverride('/home/a b/.lattice/repo'),
    "projects={'/home/a b/.lattice/repo'={trust_level='trusted'}}",
  );
});

test('buildCodexTrustOverride falls back to a basic-string key for a path containing a single quote', () => {
  assert.equal(
    buildCodexTrustOverride("C:\\Users\\o'neil\\repo"),
    `projects={"C:\\\\Users\\\\o'neil\\\\repo"={trust_level='trusted'}}`,
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
    "projects={'C:\\work trees\\repo'={trust_level='trusted'}}",
  );
  assert.ok(!command?.includes('work trees'));
});

test('cmd Codex trust value survives "%VAR%" expansion: no double quotes, exact cwd', () => {
  const env: Record<string, string> = {};
  const cwd = 'C:\\work trees\\.lattice\\repo';
  configureCodexProjectTrust('codex "go"', cwd, 'cmd.exe', env);
  const value = env[LATTICE_CODEX_TRUST_OVERRIDE_ENV];
  // cmd strips every inner `"` from a "%VAR%" expansion.
  assert.ok(!value.includes('"'), value);
  assert.equal(value, "projects={'C:\\work trees\\.lattice\\repo'={trust_level='trusted'}}");
  // The cwd appears verbatim — no JSON-doubled backslashes.
  assert.ok(value.includes(`'${cwd}'`));
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

// ---- configureCodexProjectMcp: managed MCP `-c` overrides ----

test('MCP overrides inject one --config per server, values carried in child env', () => {
  const env: Record<string, string> = {};
  const args = [
    'mcp_servers.lattice_playwright={command="cmd", args=["/c","npx"]}',
    'mcp_servers.lattice_context7={command="cmd"}',
  ];
  const command = configureCodexProjectMcp('codex --yolo "go"', args, 'cmd.exe', env);
  assert.equal(
    command,
    'codex --config "%LATTICE_CODEX_MCP_0%" --config "%LATTICE_CODEX_MCP_1%" --yolo "go"',
  );
  // The braces/quotes ride in env, never in shell source.
  assert.equal(env[codexMcpOverrideEnv(0)], args[0]);
  assert.equal(env[codexMcpOverrideEnv(1)], args[1]);
  assert.ok(!command?.includes('mcp_servers'));
});

test('MCP overrides use PowerShell / POSIX env syntax by shell', () => {
  const ps: Record<string, string> = {};
  assert.equal(
    configureCodexProjectMcp('codex "p"', ['mcp_servers.x={}'], 'pwsh.exe', ps),
    'codex --config "$env:LATTICE_CODEX_MCP_0" "p"',
  );
  const posix: Record<string, string> = {};
  assert.equal(
    configureCodexProjectMcp('codex "p"', ['mcp_servers.x={}'], '/bin/bash', posix),
    'codex --config "$LATTICE_CODEX_MCP_0" "p"',
  );
});

test('MCP overrides compose after the trust override', () => {
  const env: Record<string, string> = {};
  const trusted = configureCodexProjectTrust('codex --yolo "go"', 'C:\\repo', 'cmd.exe', env);
  const command = configureCodexProjectMcp(trusted, ['mcp_servers.x={}'], 'cmd.exe', env);
  // Both --config flags present; MCP inserted right after `codex`, trust after it.
  assert.equal(
    command,
    'codex --config "%LATTICE_CODEX_MCP_0%" --config "%LATTICE_CODEX_TRUST_OVERRIDE%" --yolo "go"',
  );
});

test('MCP overrides no-op for non-Codex commands and empty/absent arg lists', () => {
  const env: Record<string, string> = { KEEP: 'yes' };
  assert.equal(configureCodexProjectMcp('claude "p"', ['mcp_servers.x={}'], 'cmd.exe', env), 'claude "p"');
  assert.equal(configureCodexProjectMcp('codex "p"', [], 'cmd.exe', env), 'codex "p"');
  assert.equal(configureCodexProjectMcp('codex "p"', undefined, 'cmd.exe', env), 'codex "p"');
  assert.equal(configureCodexProjectMcp(undefined, ['mcp_servers.x={}'], 'cmd.exe', env), undefined);
  assert.deepEqual(env, { KEEP: 'yes' });
});
