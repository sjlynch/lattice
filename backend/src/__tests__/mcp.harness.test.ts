// Per-harness MCP resolution: the neutral resolver core (resolveMcpEntries),
// the Codex shaper (resolveCodexServers / toCodexServerConfig), and the
// per-harness toggle independence guaranteed by `mcpHarnessOverrides`. Companion
// to mcp.resolver.test.ts (which covers the Claude path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMcpEntries,
  resolveCodexServers,
  resolveClaudeServers,
} from '../mcp/registry.js';
import {
  toCodexServerConfig,
  safeCodexServerId,
} from '../mcp/codexServerConfig.js';
import {
  BUILTIN_MCP_SERVERS,
  builtinMcpServerById,
  type McpServerEntry,
} from '../mcp/catalog.js';

const ids = (entries: { entry: McpServerEntry }[]) => entries.map((e) => e.entry.id).sort();

// ---- resolveMcpEntries: harness-neutral enable + support filter ----

test('resolveMcpEntries: nothing enabled by default for any harness', () => {
  for (const h of ['claude', 'codex', 'pi'] as const) {
    assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, {}, {}, h), []);
  }
});

test('resolveMcpEntries: codex reads mcpHarnessOverrides.codex, not mcpOverrides', () => {
  // A Claude-map entry must NOT enable the server for codex.
  const claudeMap = { mcpOverrides: { context7: true } };
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, claudeMap, {}, 'codex'), []);
  // The codex map does.
  const codexMap = { mcpHarnessOverrides: { codex: { context7: true } } };
  assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, codexMap, {}, 'codex')), ['context7']);
});

test('resolveMcpEntries: per-harness independence — codex on, pi + claude stay off', () => {
  const settings = { mcpHarnessOverrides: { codex: { context7: true } } };
  assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, settings, {}, 'codex')), ['context7']);
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, settings, {}, 'pi'), []);
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, settings, {}, 'claude'), []);
});

test('resolveMcpEntries: harnessSupport filters the target harness', () => {
  const codexOnly: McpServerEntry = {
    id: 'codex-only',
    label: 'Codex only',
    description: '',
    transport: 'stdio',
    command: 'node',
    runtime: 'node',
    harnessSupport: { claude: false, codex: true, pi: false },
  };
  const settings = {
    mcpOverrides: { 'codex-only': true },
    mcpHarnessOverrides: { codex: { 'codex-only': true }, pi: { 'codex-only': true } },
  };
  // Enabled for codex (supported)...
  assert.deepEqual(ids(resolveMcpEntries([codexOnly], settings, {}, 'codex')), ['codex-only']);
  // ...filtered out for claude + pi (unsupported), even though toggled on.
  assert.deepEqual(resolveMcpEntries([codexOnly], settings, {}, 'claude'), []);
  assert.deepEqual(resolveMcpEntries([codexOnly], settings, {}, 'pi'), []);
});

test('resolveMcpEntries: codex Playwright is a plain toggle, headless by default, no QA scope', () => {
  const settings = { mcpHarnessOverrides: { codex: { playwright: true } } };
  const [pw] = resolveMcpEntries(BUILTIN_MCP_SERVERS, settings, {}, 'codex');
  assert.equal(pw.entry.id, 'playwright');
  assert.equal(pw.headless, true);
  // The QA-only Claude setting can't enable Playwright for codex.
  const qaOnly = { qaPlaywright: { enabled: true, headless: false } };
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, qaOnly, {}, 'codex'), []);
});

test('resolveMcpEntries: mcpPlaywrightHeaded flips codex + pi Playwright headed', () => {
  // The cross-harness "Show browser" opt-in reaches the codex/pi plain toggles
  // too (not just Claude's global toggle), so a watched session runs headed.
  for (const harness of ['codex', 'pi'] as const) {
    const settings = {
      mcpHarnessOverrides: { [harness]: { playwright: true } },
      mcpPlaywrightHeaded: true,
    };
    const [pw] = resolveMcpEntries(BUILTIN_MCP_SERVERS, settings, {}, harness);
    assert.equal(pw.entry.id, 'playwright');
    assert.equal(pw.headless, false);
  }
});

// ---- safeCodexServerId ----

test('safeCodexServerId: namespaced, underscore-only, dash-safe', () => {
  assert.equal(safeCodexServerId('playwright'), 'lattice_playwright');
  assert.equal(safeCodexServerId('chrome-devtools'), 'lattice_chrome_devtools');
  assert.equal(safeCodexServerId('brave-search'), 'lattice_brave_search');
  assert.equal(safeCodexServerId('a.b c'), 'lattice_a_b_c');
});

// ---- toCodexServerConfig: inline-TOML shaping ----

test('toCodexServerConfig: stdio Playwright renders command/args + headless, no secret env', () => {
  const pw = builtinMcpServerById('playwright')!;
  const { configArg, env } = toCodexServerConfig(pw, undefined, true);
  assert.ok(configArg.startsWith('mcp_servers.lattice_playwright={'));
  assert.ok(configArg.includes("'--headless'")); // single-quoted TOML literal
  assert.ok(configArg.includes("'--isolated'")); // per-session profile (no collision)
  assert.ok(configArg.includes('command='));
  assert.ok(configArg.includes('args=['));
  // No secrets → no env forwarding, no env map.
  assert.ok(!configArg.includes('env_vars'));
  assert.deepEqual(env, {});
  if (process.platform === 'win32') {
    assert.ok(configArg.includes("'cmd'")); // platformized runner
  }
});

test('toCodexServerConfig: headless=false omits --headless', () => {
  const pw = builtinMcpServerById('playwright')!;
  assert.ok(!toCodexServerConfig(pw, undefined, false).configArg.includes('--headless'));
});

test('toCodexServerConfig: a stored stdio secret rides env_vars (name in argv) + pty env (value)', () => {
  const brave = builtinMcpServerById('brave-search')!;
  const { configArg, env } = toCodexServerConfig(brave, { BRAVE_API_KEY: 'sk-secret' }, false);
  // Name forwarded (single-quoted TOML — cmd-safe), value NOT in the config string.
  assert.ok(configArg.includes("env_vars=['BRAVE_API_KEY']"));
  assert.ok(!configArg.includes('sk-secret'));
  // Value only in the pty-env map.
  assert.deepEqual(env, { BRAVE_API_KEY: 'sk-secret' });
});

test('toCodexServerConfig: a keyed server with no stored secret omits env_vars (ambient path)', () => {
  const brave = builtinMcpServerById('brave-search')!;
  const { configArg, env } = toCodexServerConfig(brave, undefined, false);
  assert.ok(!configArg.includes('env_vars'));
  assert.deepEqual(env, {});
});

test('toCodexServerConfig: http maps a secret header to env_http_headers, value in pty env only', () => {
  const entry: McpServerEntry = {
    id: 'remote-api',
    label: 'Remote',
    description: '',
    transport: 'http',
    url: 'https://x/mcp',
    headers: { Accept: 'application/json' },
    secretHeaders: ['Authorization'],
    runtime: 'remote',
    harnessSupport: { claude: true, codex: true, pi: false },
  };
  const { configArg, env } = toCodexServerConfig(entry, { Authorization: 'Bearer sk-1' }, false);
  assert.ok(configArg.includes("url='https://x/mcp'"));
  assert.ok(configArg.includes("http_headers={Accept='application/json'}"));
  // Header name → env var NAME; literal never in argv.
  assert.ok(configArg.includes('env_http_headers='));
  assert.ok(!configArg.includes('sk-1'));
  const varName = 'LATTICE_MCP_REMOTE_API_AUTHORIZATION';
  assert.ok(configArg.includes(`Authorization='${varName}'`));
  assert.deepEqual(env, { [varName]: 'Bearer sk-1' });
});

test('toCodexServerConfig: single-quoted TOML literals pass backslashes/double-quotes verbatim (cmd-safe)', () => {
  const raw = 'C:\\path\\to\\"x"'; // backslashes + double-quotes, no single quote
  const entry: McpServerEntry = {
    id: 'weird',
    label: 'Weird',
    description: '',
    transport: 'stdio',
    command: 'node',
    args: [raw],
    runtime: 'node',
    harnessSupport: { claude: true, codex: true, pi: false },
  };
  const { configArg } = toCodexServerConfig(entry, undefined, false);
  // Rendered as a single-quoted TOML literal — content is verbatim (no escaping).
  assert.ok(configArg.includes(`'${raw}'`));
});

test("toCodexServerConfig: a value containing ' falls back to a double-quoted basic string", () => {
  const raw = "O'Brien"; // literal single quote → can't be a TOML literal string
  const entry: McpServerEntry = {
    id: 'apos',
    label: 'Apos',
    description: '',
    transport: 'stdio',
    command: 'node',
    args: [raw],
    runtime: 'node',
    harnessSupport: { claude: true, codex: true, pi: false },
  };
  const { configArg } = toCodexServerConfig(entry, undefined, false);
  // Falls back to JSON.stringify (double-quoted basic) — the only TOML form that
  // can carry a `'` (cmd-degraded for that value, fine on PowerShell/POSIX).
  assert.ok(configArg.includes(JSON.stringify(raw)));
});

// ---- resolveCodexServers: the full codex shaper over the catalog ----

test('resolveCodexServers: aggregates config args + secret env for enabled codex servers', () => {
  const settings = {
    mcpHarnessOverrides: { codex: { playwright: true, 'brave-search': true } },
  };
  const secrets = { 'brave-search': { BRAVE_API_KEY: 'sk-z' } };
  const { configArgs, env } = resolveCodexServers(BUILTIN_MCP_SERVERS, settings, secrets);
  assert.equal(configArgs.length, 2);
  assert.ok(configArgs.some((a) => a.startsWith('mcp_servers.lattice_playwright=')));
  assert.ok(configArgs.some((a) => a.startsWith('mcp_servers.lattice_brave_search=')));
  assert.deepEqual(env, { BRAVE_API_KEY: 'sk-z' });
});

test('resolveCodexServers: nothing enabled → empty payload', () => {
  assert.deepEqual(resolveCodexServers(BUILTIN_MCP_SERVERS, {}, {}), { configArgs: [], env: {} });
});

test('resolveCodexServers: does not read Claude mcpOverrides', () => {
  const settings = { mcpOverrides: { playwright: true, context7: true } };
  assert.deepEqual(resolveCodexServers(BUILTIN_MCP_SERVERS, settings, {}), {
    configArgs: [],
    env: {},
  });
  // And Claude still sees them (independence both ways).
  assert.ok('context7' in resolveClaudeServers(BUILTIN_MCP_SERVERS, settings, {}));
});
