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
import { toClaudeConfig } from '../mcp/claudeServerConfig.js';
import { toPiServerConfig } from '../mcp/piServerConfig.js';
import {
  BUILTIN_MCP_SERVERS,
  builtinMcpServerById,
  type McpServerEntry,
} from '../mcp/catalog.js';
import { canonicalProjectPath } from '../projectPath.js';

const ids = (entries: { entry: McpServerEntry }[]) => entries.map((e) => e.entry.id).sort();

// Spawn context for the one `defaultEnabled` entry (Lattice's own board server).
const LATTICE_CTX = {
  projectPath: 'c:\\dev\\proj',
  apiUrl: 'http://127.0.0.1:5184',
};

// ---- resolveMcpEntries: harness-neutral enable + support filter ----

test('resolveMcpEntries: no third-party server is enabled by default for any harness', () => {
  for (const h of ['claude', 'codex', 'pi'] as const) {
    // Without a project the first-party `lattice` entry drops out too, so the
    // ctx-less set is empty for every harness...
    assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, {}, {}, h), []);
    // ...and WITH a project it is the only thing that resolves. Pinned together
    // so this can never degrade into "nothing ever resolves".
    assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, {}, {}, h, LATTICE_CTX)), [
      'lattice',
    ]);
  }
});

// ---- the first-party `lattice` server, across all three harnesses ----
//
// The single exception to the all-off invariant: it runs Lattice's own code out
// of this repo, needs no key, and only talks to the local backend that spawned
// the session. What keeps that safe is that it is project-pinned (no project →
// not resolved) and independently opt-out-able per harness.

test('lattice: an explicit false override opts out, per harness, independently', () => {
  // Claude's opt-out lives in the legacy map; codex/pi in the nested one. Each
  // must switch off ONLY its own harness.
  const claudeOff = { mcpOverrides: { lattice: false } };
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, claudeOff, {}, 'claude', LATTICE_CTX), []);
  assert.deepEqual(
    ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, claudeOff, {}, 'codex', LATTICE_CTX)),
    ['lattice'],
  );

  const codexOff = { mcpHarnessOverrides: { codex: { lattice: false } } };
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, codexOff, {}, 'codex', LATTICE_CTX), []);
  assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, codexOff, {}, 'pi', LATTICE_CTX)), [
    'lattice',
  ]);
  assert.deepEqual(
    ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, codexOff, {}, 'claude', LATTICE_CTX)),
    ['lattice'],
  );
});

test('lattice: an explicit true override is a no-op (it is already on)', () => {
  const on = {
    mcpOverrides: { lattice: true },
    mcpHarnessOverrides: { codex: { lattice: true }, pi: { lattice: true } },
  };
  for (const h of ['claude', 'codex', 'pi'] as const) {
    assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, on, {}, h, LATTICE_CTX)), [
      'lattice',
    ]);
  }
});

test('lattice: the Codex override renders an absolute Windows path as valid TOML', () => {
  // The whole `-c` string transits a `"%VAR%"` cmd.exe expansion, so the shaper
  // renders single-quoted TOML *literal* strings — which have no escapes, so a
  // `C:\Program Files\nodejs\node.exe` command and a `C:\dev\proj` env value
  // both pass through verbatim rather than being mangled into `\P` / `\d`.
  const { configArgs } = resolveCodexServers(BUILTIN_MCP_SERVERS, {}, {}, LATTICE_CTX);
  assert.equal(configArgs.length, 1);
  const arg = configArgs[0];
  assert.ok(arg.startsWith('mcp_servers.lattice_lattice={'));
  assert.ok(arg.includes(`command='${process.execPath}'`), `got ${arg}`);
  assert.ok(arg.includes("args=['"));
  assert.ok(arg.includes("LATTICE_API_URL='http://127.0.0.1:5184'"));
  assert.ok(arg.includes(`LATTICE_PROJECT='${canonicalProjectPath('c:\\dev\\proj')}'`));
  // Backslashes are NOT doubled — a TOML literal string is verbatim, and
  // doubling them here would hand Node a path with `\\` separators.
  assert.ok(!arg.includes('\\\\'), 'no JSON-style escaping inside the literal');
  // Nothing secret rides the pty env for this server.
  assert.deepEqual(resolveCodexServers(BUILTIN_MCP_SERVERS, {}, {}, LATTICE_CTX).env, {});
});

test('lattice: a path containing an apostrophe falls back to a JSON-escaped TOML basic string', () => {
  // The `'`-fallback in `tomlString` is the only branch that escapes, and it is
  // the one an odd project path (`C:\Users\O'Brien\proj`) would take. JSON's
  // escaping is TOML basic-string escaping, so backslashes MUST double there.
  const apostrophePath = "C:\\Users\\O'Brien\\proj";
  const { configArgs } = resolveCodexServers(BUILTIN_MCP_SERVERS, {}, {}, {
    projectPath: apostrophePath,
    apiUrl: 'http://127.0.0.1:5184',
  });
  const arg = configArgs[0];
  assert.ok(
    arg.includes(`LATTICE_PROJECT=${JSON.stringify(canonicalProjectPath(apostrophePath))}`),
    `got ${arg}`,
  );
});

test('resolveMcpEntries: codex reads mcpHarnessOverrides.codex, not mcpOverrides', () => {
  // A Claude-map entry must NOT enable the server for codex.
  const claudeMap = { mcpOverrides: { blender: true } };
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, claudeMap, {}, 'codex'), []);
  // The codex map does.
  const codexMap = { mcpHarnessOverrides: { codex: { blender: true } } };
  assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, codexMap, {}, 'codex')), ['blender']);
});

test('resolveMcpEntries: per-harness independence — codex on, pi + claude stay off', () => {
  const settings = { mcpHarnessOverrides: { codex: { blender: true } } };
  assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, settings, {}, 'codex')), ['blender']);
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
  assert.equal(safeCodexServerId('my-server'), 'lattice_my_server');
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

test('toCodexServerConfig: a keyed server with no stored secret still forwards the NAME (ambient path)', () => {
  // Codex starts a stdio MCP server from a cleared env (defaults + `env` +
  // `env_vars`), so an ambient key only reaches it when its name is listed.
  const brave = builtinMcpServerById('brave-search')!;
  const { configArg, env } = toCodexServerConfig(brave, undefined, false);
  assert.ok(configArg.includes("env_vars=['BRAVE_API_KEY']"));
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

test('toCodexServerConfig: a value with a newline / control char falls back to a basic string too', () => {
  // A newline inside a single-quoted TOML literal is invalid TOML — the whole
  // `-c` override (and the Codex spawn) used to fail on it. JSON escapes are
  // valid TOML basic-string escapes, so JSON.stringify carries it correctly.
  const withNewline = 'line one\nline two';
  const withControl = 'bell\x07here';
  const withTab = 'a\tb'; // tab IS allowed in a literal string — stays single-quoted
  const entry: McpServerEntry = {
    id: 'ctrl',
    label: 'Ctrl',
    description: '',
    transport: 'stdio',
    command: 'node',
    args: [withNewline, withControl, withTab],
    env: { 'X.Y\nZ': 'v' }, // a control char in a KEY takes the same fallback
    runtime: 'node',
    harnessSupport: { claude: true, codex: true, pi: false },
  };
  const { configArg } = toCodexServerConfig(entry, undefined, false);
  assert.ok(configArg.includes(JSON.stringify(withNewline)));
  assert.ok(configArg.includes(JSON.stringify(withControl)));
  assert.ok(configArg.includes(`'${withTab}'`));
  assert.ok(configArg.includes(`${JSON.stringify('X.Y\nZ')}='v'`));
  // No raw newline anywhere in the rendered override.
  assert.ok(!configArg.includes('\n'));
});

test('resolveCodexServers: ids that fold to the same Codex key / env var are not silently merged', () => {
  const mk = (id: string): McpServerEntry => ({
    id,
    label: id,
    description: '',
    transport: 'http',
    url: `https://${id}.example/mcp`,
    secretHeaders: ['Authorization'],
    runtime: 'remote',
    harnessSupport: { claude: true, codex: true, pi: true },
  });
  // `my-api` and `my_api` both fold to `lattice_my_api` (and to the same
  // LATTICE_MCP_MY_API_AUTHORIZATION secret var). Before: the second's `-c`
  // override replaced the first's table entry and its secret overwrote the
  // first's in the pty env. Now: the first wins, the second is skipped.
  const catalog = [mk('my-api'), mk('my_api')];
  const settings = { mcpHarnessOverrides: { codex: { 'my-api': true, my_api: true } } };
  const secrets = {
    'my-api': { Authorization: 'Bearer first' },
    my_api: { Authorization: 'Bearer second' },
  };
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    const { configArgs, env } = resolveCodexServers(catalog, settings, secrets);
    assert.equal(configArgs.length, 1);
    assert.ok(configArgs[0].includes("url='https://my-api.example/mcp'"));
    assert.deepEqual(env, { LATTICE_MCP_MY_API_AUTHORIZATION: 'Bearer first' });
    assert.ok(warnings.some((w) => w.includes('my_api') && w.includes('collides')));
  } finally {
    console.warn = origWarn;
  }
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

test('resolveCodexServers: nothing enabled and no project → empty payload', () => {
  // No spawn context ⇒ not even the default-on `lattice` server (it has no
  // board to serve). With one, it is the sole entry — covered above.
  assert.deepEqual(resolveCodexServers(BUILTIN_MCP_SERVERS, {}, {}), { configArgs: [], env: {} });
});

test('resolveCodexServers: does not read Claude mcpOverrides', () => {
  const settings = { mcpOverrides: { playwright: true, blender: true } };
  assert.deepEqual(resolveCodexServers(BUILTIN_MCP_SERVERS, settings, {}), {
    configArgs: [],
    env: {},
  });
  // And Claude still sees them (independence both ways).
  assert.ok('blender' in resolveClaudeServers(BUILTIN_MCP_SERVERS, settings, {}));
});

// ---- blender: telemetry stays off on every harness ----
//
// blender-mcp ships `TelemetryConfig.enabled = True` and posts per-tool-call
// events to the vendor's Supabase. The addon's "Allow Telemetry" checkbox only
// gates the private payload (prompt text / code / scene info / screenshots) and
// FAILS OPEN when its preferences lookup misses, so the kill switch that
// actually holds is the env var the server reads in its own constructor. Lattice
// spawns agents unattended, so no harness may launch this server without it.

const TELEMETRY_OFF_VARS = [
  'DISABLE_TELEMETRY',
  'BLENDER_MCP_DISABLE_TELEMETRY',
  'MCP_DISABLE_TELEMETRY',
] as const;

test('blender: the catalog entry declares every telemetry kill switch', () => {
  const blender = builtinMcpServerById('blender')!;
  for (const name of TELEMETRY_OFF_VARS) {
    assert.equal(blender.env?.[name], 'true', `${name} must be set on the catalog entry`);
  }
});

test('blender: all three shapers carry the telemetry-off env to the spawned server', () => {
  const blender = builtinMcpServerById('blender')!;

  // Claude → `~/.claude.json` per-server `env`.
  const claude = toClaudeConfig(blender, undefined, false);
  assert.equal(claude.type, 'stdio');
  for (const name of TELEMETRY_OFF_VARS) {
    assert.equal(
      claude.type === 'stdio' ? claude.env?.[name] : undefined,
      'true',
      `claude config must set ${name}`,
    );
  }

  // Codex → inline-TOML `env={…}` on the `-c` override. Static (non-secret) env
  // is rendered inline, so assert on the rendered pairs rather than `env_vars`
  // (which carries secret NAMES only).
  const codex = toCodexServerConfig(blender, undefined, false);
  for (const name of TELEMETRY_OFF_VARS) {
    assert.ok(
      codex.configArg.includes(`${name}='true'`),
      `codex override must render ${name}='true' — got ${codex.configArg}`,
    );
  }
  // Nothing secret here, so no value should ride the pty env.
  assert.deepEqual(codex.env, {});

  // Pi → `.pi/mcp.json` per-server `env`.
  const pi = toPiServerConfig(blender, undefined, false);
  for (const name of TELEMETRY_OFF_VARS) {
    assert.equal(pi.config.env?.[name], 'true', `pi config must set ${name}`);
  }
  assert.deepEqual(pi.env, {});
});

// Regression: the LATTICE_* strip on the lattice entry's env was
// case-sensitive, but the Windows environment is not — a `lattice_task_id`
// override key reached the server as LATTICE_TASK_ID for every spawn.
test('resolveMcpEntries: the lattice entry drops LATTICE_* env keys in any case', () => {
  const lattice = builtinMcpServerById('lattice')!;
  const catalog = [{ ...lattice, env: { ...(lattice.env ?? {}), lattice_task_id: 't_bogus', Lattice_Project: 'x', KEEP: '1' } }];
  const [resolved] = resolveMcpEntries(catalog, {}, {}, 'claude', LATTICE_CTX);
  const env = resolved.entry.env ?? {};
  assert.equal(env.KEEP, '1');
  assert.deepEqual(
    Object.keys(env).filter((k) => /^lattice_/i.test(k)).sort(),
    ['LATTICE_API_URL', 'LATTICE_PROJECT'],
  );
});
