import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANAGED_MCP_MARKER,
  platformizeCommand,
  reconcileMcpServers,
  type ClaudeMcpServerConfig,
} from '../mcp/claudeInject.js';
import { parseCodexMcpServers, normalizeServer } from '../mcp/importConfigs.js';
import { redactSecrets, secretHints } from '../mcp/secrets.js';
import { resolveClaudeServers } from '../mcp/registry.js';
import {
  BUILTIN_MCP_SERVERS,
  builtinMcpServerById,
  type McpServerEntry,
} from '../mcp/catalog.js';
import {
  sanitizeCustomServers,
  sanitizeBuiltinOverrides,
} from '../globalSettings.js';

// Narrow a resolved config to its stdio shape for assertions.
type Stdio = { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };
const asStdio = (c: unknown) => c as Stdio;

// ---- reconcileMcpServers: the injection-hygiene contract ----
//
// Managed servers are added/updated, previously-managed-now-disabled ones are
// stripped, and the user's own hand-added entries are never touched.

function cfg(command: string): ClaudeMcpServerConfig {
  return { type: 'stdio', command };
}

test('reconcile adds managed servers and records the marker', () => {
  const entry: Record<string, unknown> = {};
  reconcileMcpServers(entry, { brave: cfg('npx') });
  assert.deepEqual(entry.mcpServers, { brave: cfg('npx') });
  assert.deepEqual(entry[MANAGED_MCP_MARKER], ['brave']);
});

test('reconcile preserves the user’s own (unmanaged) servers', () => {
  const entry: Record<string, unknown> = {
    mcpServers: { mine: cfg('node') },
  };
  reconcileMcpServers(entry, { brave: cfg('npx') });
  assert.deepEqual(entry.mcpServers, { mine: cfg('node'), brave: cfg('npx') });
});

test('reconcile strips a previously-managed server that is now disabled', () => {
  const entry: Record<string, unknown> = {
    mcpServers: { brave: cfg('npx'), mine: cfg('node') },
    [MANAGED_MCP_MARKER]: ['brave'],
  };
  // brave no longer in the managed set → stripped; user's `mine` stays.
  reconcileMcpServers(entry, {});
  assert.deepEqual(entry.mcpServers, { mine: cfg('node') });
  assert.equal(entry[MANAGED_MCP_MARKER], undefined);
});

test('reconcile drops the marker when nothing is managed', () => {
  const entry: Record<string, unknown> = {};
  reconcileMcpServers(entry, {});
  assert.deepEqual(entry.mcpServers, {});
  assert.ok(!(MANAGED_MCP_MARKER in entry));
});

// ---- platformizeCommand: Windows package-runner wrapping ----

test('platformizeCommand wraps npx in cmd /c on win32, passes node through', () => {
  const wrapped = platformizeCommand('npx', ['-y', 'pkg']);
  const node = platformizeCommand('node', ['server.js']);
  if (process.platform === 'win32') {
    assert.deepEqual(wrapped, { command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] });
    assert.deepEqual(node, { command: 'node', args: ['server.js'] });
  } else {
    assert.deepEqual(wrapped, { command: 'npx', args: ['-y', 'pkg'] });
  }
});

// ---- parseCodexMcpServers: minimal TOML reader for [mcp_servers.*] ----

test('parseCodexMcpServers reads command/args/env tables and ignores other sections', () => {
  const toml = `
# top of file
[mcp_servers.brave]
command = "npx"
args = ["-y", "@brave/brave-search-mcp-server"]
env = { BRAVE_API_KEY = "sk-literal" }

[mcp_servers."my-http"]
url = "https://example.com/mcp"
bearer_token_env_var = "MY_TOKEN"

[some_other_section]
command = "ignored"
`;
  const parsed = parseCodexMcpServers(toml);
  assert.deepEqual(parsed.brave, {
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    env: { BRAVE_API_KEY: 'sk-literal' },
  });
  assert.deepEqual(parsed['my-http'], {
    url: 'https://example.com/mcp',
    bearer_token_env_var: 'MY_TOKEN',
  });
  assert.ok(!('some_other_section' in parsed));
});

test('parseCodexMcpServers strips trailing comments outside strings', () => {
  const toml = `[mcp_servers.x]\ncommand = "npx" # run via npx\n`;
  assert.equal(parseCodexMcpServers(toml).x.command, 'npx');
});

// ---- secrets redaction: never the value, just presence + last-4 ----

test('redactSecrets reduces values to presence booleans', () => {
  const redacted = redactSecrets({ brave: { BRAVE_API_KEY: 'sk-supersecret' } });
  assert.deepEqual(redacted, { brave: { BRAVE_API_KEY: true } });
});

test('secretHints reveals only the last 4 characters', () => {
  const hints = secretHints({ brave: { BRAVE_API_KEY: 'sk-abcd1234wxyz' } });
  assert.equal(hints.brave.BRAVE_API_KEY, '••••wxyz');
});

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

// ---- normalizeServer: import secret-classification (security-relevant) ----

test('normalize: a literal secret env value is stored, never kept inline', () => {
  const n = normalizeServer(
    'svc',
    { command: 'npx', args: ['-y', 'svc'], env: { API_KEY: 'sk-literal', NODE_ENV: 'production' } },
    'test',
  );
  assert.ok(n);
  // Secret-named literal → stored + listed, and absent from the inline entry env.
  assert.equal(n.secrets.API_KEY, 'sk-literal');
  assert.ok(n.entry.secretEnvVars?.includes('API_KEY'));
  assert.equal(n.entry.env?.API_KEY, undefined);
  // Plain config → kept inline, not treated as a secret.
  assert.equal(n.entry.env?.NODE_ENV, 'production');
  assert.ok(!n.secrets.NODE_ENV);
});

test('normalize: a ${reference} env value is recorded but not stored (ambient)', () => {
  const n = normalizeServer(
    'svc',
    { command: 'npx', args: ['svc'], env: { TOKEN: '${input:my-token}' } },
    'test',
  );
  assert.ok(n);
  assert.ok(n.entry.secretEnvVars?.includes('TOKEN'));
  assert.equal(n.secrets.TOKEN, undefined); // never stored — resolves from ambient env
  assert.equal(n.entry.env?.TOKEN, undefined);
});

test('normalize: http server keeps url + records bearer_token_env_var as a ref', () => {
  const n = normalizeServer(
    'remote',
    { url: 'https://x/mcp', bearer_token_env_var: 'MY_TOKEN' },
    'test',
  );
  assert.ok(n);
  assert.equal(n.entry.transport, 'http');
  assert.equal(n.entry.url, 'https://x/mcp');
  assert.equal(n.entry.runtime, 'remote');
  assert.ok(n.entry.secretEnvVars?.includes('MY_TOKEN'));
  assert.equal(n.secrets.MY_TOKEN, undefined);
});

test('normalize: runtime is detected from the command; junk is rejected', () => {
  assert.equal(normalizeServer('a', { command: 'uvx', args: [] }, 't')?.entry.runtime, 'uv');
  assert.equal(normalizeServer('b', { command: 'docker', args: [] }, 't')?.entry.runtime, 'docker');
  assert.equal(normalizeServer('c', { command: 'npx', args: [] }, 't')?.entry.runtime, 'node');
  // Neither command nor url → nothing runnable → null.
  assert.equal(normalizeServer('d', {}, 't'), null);
});

// ---- globalSettings sanitize: untrusted-input validation ----

test('sanitizeCustomServers keeps valid entries, drops idless junk, forces builtin:false', () => {
  const out = sanitizeCustomServers([
    { id: 'good', command: 'npx', args: ['-y', 'x', 42], builtin: true },
    { label: 'no id' },
    'garbage',
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'good');
  assert.equal(out[0].builtin, false); // can't smuggle builtin:true
  assert.deepEqual(out[0].args, ['-y', 'x']); // non-string arg filtered
  assert.equal(out[0].harnessSupport.claude, true); // default-on for claude
  assert.equal(out[0].harnessSupport.pi, false);
});

test('sanitizeBuiltinOverrides keeps only the editable fields', () => {
  const out = sanitizeBuiltinOverrides({
    playwright: {
      args: ['-y', '@playwright/mcp@latest', '--browser', 'firefox'],
      env: { FOO: 'bar' },
      runtimeNote: 'tweaked',
      id: 'evil',
    },
    bogus: 'not an object',
  });
  assert.deepEqual(out.playwright.args, ['-y', '@playwright/mcp@latest', '--browser', 'firefox']);
  assert.deepEqual(out.playwright.env, { FOO: 'bar' });
  assert.equal(out.playwright.runtimeNote, 'tweaked');
  assert.ok(!('id' in out.playwright)); // identity can't be overridden
  assert.ok(!('bogus' in out));
});

test('sanitizeBuiltinOverrides drops command/url (no executable/endpoint swap)', () => {
  // A built-in override must not be able to re-point what the server runs.
  // Dropping command/url here keeps "definitions live in code" honest and
  // stops "toggle a known-safe built-in" from becoming "run an arbitrary
  // command" once enabled per-project.
  const out = sanitizeBuiltinOverrides({
    'brave-search': { command: 'C:/evil.exe', args: ['--pwn'], url: 'http://attacker/' },
  });
  assert.ok(!('command' in out['brave-search'])); // executable can't be overridden
  assert.ok(!('url' in out['brave-search'])); // endpoint can't be overridden
  assert.deepEqual(out['brave-search'].args, ['--pwn']); // safe field still applied
});

test('registry: a built-in override cannot replace the catalog command', () => {
  // End-to-end: feed a malicious override through the sanitizer (the same path
  // getGlobalSettings runs on read) and apply it the way mergedCatalog does.
  // The built-in keeps its code-defined runner; only the safe arg tweak lands.
  const brave = builtinMcpServerById('brave-search');
  assert.ok(brave);
  const overrides = sanitizeBuiltinOverrides({
    'brave-search': { command: 'C:/evil.exe', args: ['--y', 'pwn'] },
  });
  const ov = overrides['brave-search'];
  const merged = { ...brave, ...ov, id: brave.id, builtin: true as const };
  assert.equal(merged.command, brave.command); // still 'npx', not the injected exe
  assert.deepEqual(merged.args, ['--y', 'pwn']); // safe arg override still applies
});
