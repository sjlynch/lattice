// MCP resolve path: the pure resolver core (resolveClaudeServers), the two-scope
// Playwright policy (resolvePlaywright), and Claude per-server config shaping
// (secretEnvVarsFor + toClaudeConfig, incl. secret env/header re-injection).
// Split out of the original monolithic mcp.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaudeServers } from '../mcp/registry.js';
import { resolvePlaywright } from '../mcp/resolverPolicy.js';
import { secretEnvVarsFor, toClaudeConfig } from '../mcp/claudeServerConfig.js';
import {
  BUILTIN_MCP_SERVERS,
  builtinMcpServerById,
  type McpServerEntry,
} from '../mcp/catalog.js';

// Narrow a resolved config to its stdio shape for assertions.
type Stdio = { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };
const asStdio = (c: unknown) => c as Stdio;

// ---- resolveClaudeServers: the pure resolver core ----

test('resolve: nothing enabled by default (the all-off invariant)', () => {
  assert.deepEqual(resolveClaudeServers(BUILTIN_MCP_SERVERS, {}, {}), {});
});

test('resolve: global Playwright (mcpOverrides) is on for any session, headless', () => {
  // mcpOverrides.playwright = the GLOBAL toggle (Settings → MCP tab): enabled
  // regardless of isQaRun, and always headless (background/unattended use).
  const ordinary = resolveClaudeServers(
    BUILTIN_MCP_SERVERS,
    { mcpOverrides: { playwright: true } },
    {},
  );
  assert.ok('playwright' in ordinary);
  assert.ok(asStdio(ordinary.playwright).args?.includes('--headless'));

  const onQaRun = resolveClaudeServers(
    BUILTIN_MCP_SERVERS,
    { mcpOverrides: { playwright: true } },
    {},
    { isQaRun: true },
  );
  assert.ok('playwright' in onQaRun);
});

test('resolve: QA Playwright (qaPlaywright) is QA-runs-only', () => {
  const settings = { qaPlaywright: { enabled: true, headless: true } };
  // Not a QA run → NOT injected: the QA toggle never leaks into ordinary
  // (task / sidebar / push) sessions.
  const ordinary = resolveClaudeServers(BUILTIN_MCP_SERVERS, settings, {});
  assert.ok(!('playwright' in ordinary));
  // QA run → injected, headless per the QA eye toggle.
  const qaRun = resolveClaudeServers(BUILTIN_MCP_SERVERS, settings, {}, { isQaRun: true });
  assert.ok('playwright' in qaRun);
  assert.ok(asStdio(qaRun.playwright).args?.includes('--headless'));
});

test('resolve: headed QA Playwright omits --headless (QA run only)', () => {
  const out = resolveClaudeServers(
    BUILTIN_MCP_SERVERS,
    { qaPlaywright: { enabled: true, headless: false } },
    {},
    { isQaRun: true },
  );
  assert.ok('playwright' in out);
  assert.ok(!asStdio(out.playwright).args?.includes('--headless'));
});

test('resolve: on a QA run the QA eye toggle wins over the global toggle', () => {
  // Both on: the global toggle alone would force headless, but a QA run honors
  // the QA lane's headed choice so "watch it test" stays authoritative.
  const out = resolveClaudeServers(
    BUILTIN_MCP_SERVERS,
    {
      mcpOverrides: { playwright: true },
      qaPlaywright: { enabled: true, headless: false },
    },
    {},
    { isQaRun: true },
  );
  assert.ok('playwright' in out);
  assert.ok(!asStdio(out.playwright).args?.includes('--headless'));
});

test('resolve: a keyed server injects the stored secret into env', () => {
  const out = resolveClaudeServers(
    BUILTIN_MCP_SERVERS,
    { mcpOverrides: { 'brave-search': true } },
    { 'brave-search': { BRAVE_API_KEY: 'sk-stored' } },
  );
  assert.equal(asStdio(out['brave-search']).env?.BRAVE_API_KEY, 'sk-stored');
});

test('resolve: a keyed server with no stored secret omits env (ambient path)', () => {
  const out = resolveClaudeServers(
    BUILTIN_MCP_SERVERS,
    { mcpOverrides: { 'brave-search': true } },
    {},
  );
  // env omitted entirely so the harness can inherit BRAVE_API_KEY from the shell.
  assert.equal(asStdio(out['brave-search']).env, undefined);
});

test('resolve: an explicit false override stays off', () => {
  const out = resolveClaudeServers(
    BUILTIN_MCP_SERVERS,
    { mcpOverrides: { 'brave-search': false, context7: true } },
    {},
  );
  assert.ok(!('brave-search' in out));
  assert.ok('context7' in out);
});

test('resolve: a server not supporting Claude is filtered out', () => {
  const custom: McpServerEntry = {
    id: 'pi-only',
    label: 'Pi only',
    description: '',
    transport: 'stdio',
    command: 'node',
    runtime: 'node',
    harnessSupport: { claude: false, codex: true, pi: true },
  };
  const out = resolveClaudeServers([custom], { mcpOverrides: { 'pi-only': true } }, {});
  assert.deepEqual(out, {});
});

test('resolve: enabling Brave injects its secret + win32-wraps the command', () => {
  const brave = builtinMcpServerById('brave-search');
  assert.ok(brave);
  const out = resolveClaudeServers(
    [brave],
    { mcpOverrides: { 'brave-search': true } },
    { 'brave-search': { BRAVE_API_KEY: 'sk-1' } },
  );
  const cfg = asStdio(out['brave-search']);
  assert.equal(cfg.env?.BRAVE_API_KEY, 'sk-1');
  if (process.platform === 'win32') {
    assert.equal(cfg.command, 'cmd');
    assert.deepEqual(cfg.args?.slice(0, 3), ['/c', 'npx', '-y']);
  } else {
    assert.equal(cfg.command, 'npx');
  }
});

// ---- resolverPolicy.resolvePlaywright: the two-scope enable/headless policy ----
//
// Direct unit coverage of the policy helper now that it lives apart from the
// resolve orchestration. `resolveClaudeServers` (above) is the integration view.

test('resolvePlaywright: off when neither switch is set', () => {
  assert.deepEqual(resolvePlaywright({}, false), { enabled: false, headless: true });
  assert.deepEqual(resolvePlaywright({}, true), { enabled: false, headless: true });
});

test('resolvePlaywright: the global toggle is on for any run, always headless', () => {
  const s = { mcpOverrides: { playwright: true } };
  assert.deepEqual(resolvePlaywright(s, false), { enabled: true, headless: true });
  assert.deepEqual(resolvePlaywright(s, true), { enabled: true, headless: true });
});

test('resolvePlaywright: the QA toggle is QA-runs-only and carries its headless flag', () => {
  const headed = { qaPlaywright: { enabled: true, headless: false } };
  // Not a QA run → never enabled by the QA toggle alone.
  assert.equal(resolvePlaywright(headed, false).enabled, false);
  // QA run → enabled, and the QA eye toggle wins over the global default.
  assert.deepEqual(resolvePlaywright(headed, true), { enabled: true, headless: false });
  // QA toggle with headless on → headless.
  assert.deepEqual(
    resolvePlaywright({ qaPlaywright: { enabled: true, headless: true } }, true),
    { enabled: true, headless: true },
  );
});

test('resolvePlaywright: on a QA run the QA headed choice beats the global toggle', () => {
  const out = resolvePlaywright(
    { mcpOverrides: { playwright: true }, qaPlaywright: { enabled: true, headless: false } },
    true,
  );
  assert.deepEqual(out, { enabled: true, headless: false });
});

// ---- claudeServerConfig: secret-env selection + Claude config shaping ----

test('secretEnvVarsFor: unions requiresSecret.envVar with secretEnvVars, deduped', () => {
  const entry: McpServerEntry = {
    id: 'svc',
    label: 'Svc',
    description: '',
    transport: 'stdio',
    command: 'node',
    runtime: 'node',
    secretEnvVars: ['EXTRA', 'BRAVE_API_KEY'],
    requiresSecret: { envVar: 'BRAVE_API_KEY', label: 'k' },
    harnessSupport: { claude: true, codex: false, pi: false },
  };
  assert.deepEqual(secretEnvVarsFor(entry).sort(), ['BRAVE_API_KEY', 'EXTRA']);
  // No secrets declared → empty.
  assert.deepEqual(
    secretEnvVarsFor({ ...entry, secretEnvVars: undefined, requiresSecret: undefined }),
    [],
  );
});

test('toClaudeConfig: Playwright appends --headless only when headless', () => {
  const pw = builtinMcpServerById('playwright');
  assert.ok(pw);
  assert.ok(asStdio(toClaudeConfig(pw, undefined, true)).args?.includes('--headless'));
  assert.ok(!asStdio(toClaudeConfig(pw, undefined, false)).args?.includes('--headless'));
});

test('toClaudeConfig: http transport keeps url + plain headers, ignores headless', () => {
  const entry: McpServerEntry = {
    id: 'remote',
    label: 'Remote',
    description: '',
    transport: 'http',
    url: 'https://x/mcp',
    headers: { Authorization: 'Bearer t' },
    runtime: 'remote',
    harnessSupport: { claude: true, codex: false, pi: false },
  };
  // No secretHeaders declared → serverSecrets is irrelevant; plain headers stay.
  assert.deepEqual(toClaudeConfig(entry, { IGNORED: 'v' }, true), {
    type: 'http',
    url: 'https://x/mcp',
    headers: { Authorization: 'Bearer t' },
  });
  // Empty headers object is dropped.
  assert.deepEqual(toClaudeConfig({ ...entry, headers: {} }, undefined, false), {
    type: 'http',
    url: 'https://x/mcp',
  });
});

test('toClaudeConfig: http re-injects a secret header from the secrets file', () => {
  // Header-level indirection (the import secret-leak fix): the literal auth value
  // is NOT inline on the entry — it lives in the secrets file and is folded back
  // in here at resolve time, keyed by header name.
  const entry: McpServerEntry = {
    id: 'remote',
    label: 'Remote',
    description: '',
    transport: 'http',
    url: 'https://x/mcp',
    headers: { Accept: 'application/json' }, // plain header stays inline
    secretHeaders: ['Authorization'],
    runtime: 'remote',
    harnessSupport: { claude: true, codex: false, pi: false },
  };
  assert.deepEqual(toClaudeConfig(entry, { Authorization: 'Bearer sk-stored' }, false), {
    type: 'http',
    url: 'https://x/mcp',
    headers: { Accept: 'application/json', Authorization: 'Bearer sk-stored' },
  });
  // No stored value → the secret header is omitted (placeholder/ambient gap),
  // never emitted empty.
  assert.deepEqual(toClaudeConfig(entry, {}, false), {
    type: 'http',
    url: 'https://x/mcp',
    headers: { Accept: 'application/json' },
  });
});
