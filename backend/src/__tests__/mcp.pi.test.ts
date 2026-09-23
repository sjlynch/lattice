// Pi MCP shaping + config reconcile: the Pi shaper (resolvePiServers /
// toPiServerConfig) and the `.pi/mcp.json` marker reconcile
// (reconcilePiMcpDocument). Companion to mcp.harness.test.ts (Codex) and
// mcp.resolver.test.ts (Claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePiServers } from '../mcp/registry.js';
import { toPiServerConfig } from '../mcp/piServerConfig.js';
import { reconcilePiMcpDocument, writePiMcpConfig } from '../piMcp/config.js';
import { withTempDir } from './helpers/tempDir.js';
import {
  BUILTIN_MCP_SERVERS,
  builtinMcpServerById,
  type McpServerEntry,
} from '../mcp/catalog.js';
import { canonicalProjectPath } from '../projectPath.js';

// ---- toPiServerConfig ----

test('toPiServerConfig: stdio Playwright — eager lifecycle, direct tools, headless arg, no secret env', () => {
  const pw = builtinMcpServerById('playwright')!;
  const { config, env } = toPiServerConfig(pw, undefined, true);
  assert.equal(config.lifecycle, 'eager');
  assert.equal(config.directTools, true); // register tools individually (parity)
  assert.ok(config.args?.includes('--headless'));
  // `--isolated` so concurrent Pi sessions don't collide on the shared profile.
  assert.ok(config.args?.includes('--isolated'));
  assert.deepEqual(env, {});
  if (process.platform === 'win32') {
    assert.equal(config.command, 'cmd'); // platformized npx
    assert.deepEqual(config.args?.slice(0, 3), ['/c', 'set', 'NoDefaultCurrentDirectoryInExePath=1&&npx']);
  } else {
    assert.equal(config.command, 'npx');
  }
});

test('toPiServerConfig: headless=false omits --headless', () => {
  const pw = builtinMcpServerById('playwright')!;
  assert.ok(!toPiServerConfig(pw, undefined, false).config.args?.includes('--headless'));
});

test('toPiServerConfig: a stored stdio secret rides the pty env, NOT the JSON file', () => {
  const brave = builtinMcpServerById('brave-search')!;
  const { config, env } = toPiServerConfig(brave, { BRAVE_API_KEY: 'sk-secret' }, false);
  // Value only in the pty-env map; nothing secret in the config the extension
  // reads (it inherits the child's process.env — no ${VAR} interpolation).
  assert.deepEqual(env, { BRAVE_API_KEY: 'sk-secret' });
  assert.equal(config.env, undefined);
  assert.ok(!JSON.stringify(config).includes('sk-secret'));
});

test('toPiServerConfig: http references a secret header via ${VAR}, value in pty env only', () => {
  const entry: McpServerEntry = {
    id: 'remote-api',
    label: 'Remote',
    description: '',
    transport: 'http',
    url: 'https://x/mcp',
    headers: { Accept: 'application/json' },
    secretHeaders: ['Authorization'],
    runtime: 'remote',
    harnessSupport: { claude: true, codex: true, pi: true },
  };
  const { config, env } = toPiServerConfig(entry, { Authorization: 'Bearer sk-1' }, false);
  // Adapter infers transport from `url` presence — the type carries no
  // `transport` field (enforced at compile time).
  assert.equal(config.url, 'https://x/mcp');
  assert.equal(config.lifecycle, 'eager');
  assert.equal(config.directTools, true);
  // Static header kept verbatim; the secret header is a ${VAR} reference the
  // adapter interpolates at spawn — the literal never lands in the JSON file.
  const varName = 'LATTICE_MCP_REMOTE_API_AUTHORIZATION';
  assert.deepEqual(config.headers, {
    Accept: 'application/json',
    Authorization: `\${${varName}}`,
  });
  assert.ok(!JSON.stringify(config).includes('sk-1'));
  // Value only in the pty-env map, under the shared Codex/Pi naming.
  assert.deepEqual(env, { [varName]: 'Bearer sk-1' });
});

test('toPiServerConfig: http with an unfilled secret header omits it (no empty ref)', () => {
  const entry: McpServerEntry = {
    id: 'remote-api',
    label: 'Remote',
    description: '',
    transport: 'http',
    url: 'https://x/mcp',
    secretHeaders: ['Authorization'],
    runtime: 'remote',
    harnessSupport: { claude: true, codex: true, pi: true },
  };
  const { config, env } = toPiServerConfig(entry, undefined, false);
  // No stored value → the header is left for the user to supply; nothing emitted.
  assert.equal(config.headers, undefined);
  assert.deepEqual(env, {});
});

// ---- writePiMcpConfig ----

const MANAGED_LATTICE = {
  lattice: { command: 'node', args: ['server.js'], lifecycle: 'eager' as const, directTools: true },
};

test('writePiMcpConfig: an absent .pi/mcp.json is created with the managed set + marker', async () => {
  await withTempDir('lattice-pimcp-', async (dir) => {
    await writePiMcpConfig(dir, MANAGED_LATTICE);
    const doc = JSON.parse(await fs.readFile(path.join(dir, '.pi', 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(doc.mcpServers), ['lattice']);
    assert.deepEqual(doc.__latticeManagedMcp, ['lattice']);
  });
});

test('writePiMcpConfig: a hand-written file that does not parse is left untouched', async () => {
  await withTempDir('lattice-pimcp-', async (dir) => {
    const file = path.join(dir, '.pi', 'mcp.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Mid-edit / commented — exactly what a user's project-root file looks
    // like while they are typing in it. "Unparseable" used to be treated like
    // "absent" and the file was replaced from scratch.
    const midEdit = '{\n  // my servers\n  "mcpServers": { "mine": { "command": "x"';
    await fs.writeFile(file, midEdit, 'utf8');
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      await writePiMcpConfig(dir, MANAGED_LATTICE);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(await fs.readFile(file, 'utf8'), midEdit);
    assert.ok(warnings.some((w) => w.includes('refusing to overwrite')));
    // No temp file left beside it either.
    const siblings = await fs.readdir(path.dirname(file));
    assert.deepEqual(siblings, ['mcp.json']);
  });
});

// ---- resolvePiServers ----

test('resolvePiServers: a second server whose secret env var folds onto a taken name is skipped', () => {
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
  // `my-api` / `my_api` share LATTICE_MCP_MY_API_AUTHORIZATION; the second's
  // secret used to overwrite the first's in the pty env while both `${VAR}`
  // references pointed at it.
  const catalog = [mk('my-api'), mk('my_api')];
  const settings = { mcpHarnessOverrides: { pi: { 'my-api': true, my_api: true } } };
  const secrets = {
    'my-api': { Authorization: 'Bearer first' },
    my_api: { Authorization: 'Bearer second' },
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const { mcpServers, env } = resolvePiServers(catalog, settings, secrets);
    assert.deepEqual(Object.keys(mcpServers), ['my-api']);
    assert.deepEqual(env, { LATTICE_MCP_MY_API_AUTHORIZATION: 'Bearer first' });
  } finally {
    console.warn = origWarn;
  }
});

test('resolvePiServers: reads mcpHarnessOverrides.pi only, keyed by server id', () => {
  const settings = { mcpHarnessOverrides: { pi: { playwright: true, blender: true } } };
  const { mcpServers, env } = resolvePiServers(BUILTIN_MCP_SERVERS, settings, {});
  assert.deepEqual(Object.keys(mcpServers).sort(), ['blender', 'playwright']);
  assert.deepEqual(env, {});
  // Claude / Codex maps don't leak into Pi.
  assert.deepEqual(
    resolvePiServers(BUILTIN_MCP_SERVERS, { mcpOverrides: { blender: true } }, {}),
    { mcpServers: {}, env: {} },
  );
  assert.deepEqual(
    resolvePiServers(
      BUILTIN_MCP_SERVERS,
      { mcpHarnessOverrides: { codex: { blender: true } } },
      {},
    ),
    { mcpServers: {}, env: {} },
  );
});

test('resolvePiServers: the first-party lattice server resolves with a project, not without', () => {
  // The one `defaultEnabled` entry. Pi reads it out of the same neutral core, so
  // the shape it lands in `.pi/mcp.json` is what matters here: an absolute node
  // binary (never `cmd`-wrapped), the entry path, and the per-spawn env.
  const ctx = { projectPath: 'c:\\dev\\proj', apiUrl: 'http://127.0.0.1:5184' };
  assert.deepEqual(resolvePiServers(BUILTIN_MCP_SERVERS, {}, {}), { mcpServers: {}, env: {} });

  const { mcpServers, env } = resolvePiServers(BUILTIN_MCP_SERVERS, {}, {}, ctx);
  assert.deepEqual(Object.keys(mcpServers), ['lattice']);
  const cfg = mcpServers.lattice;
  assert.equal(cfg.command, process.execPath);
  assert.ok(cfg.args?.[0]?.endsWith('server.js'));
  assert.equal(cfg.env?.LATTICE_API_URL, 'http://127.0.0.1:5184');
  assert.equal(cfg.env?.LATTICE_PROJECT, canonicalProjectPath('c:\\dev\\proj'));
  // Non-secret config, so nothing rides the pty env.
  assert.deepEqual(env, {});
  // Tools registered individually (parity with the other servers).
  assert.equal(cfg.directTools, true);
  assert.equal(cfg.lifecycle, 'eager');

  // And the per-harness opt-out reaches Pi.
  assert.deepEqual(
    resolvePiServers(BUILTIN_MCP_SERVERS, { mcpHarnessOverrides: { pi: { lattice: false } } }, {}, ctx),
    { mcpServers: {}, env: {} },
  );
});

test('resolvePiServers: aggregates secret env for enabled keyed servers', () => {
  const settings = { mcpHarnessOverrides: { pi: { 'brave-search': true } } };
  const { mcpServers, env } = resolvePiServers(BUILTIN_MCP_SERVERS, settings, {
    'brave-search': { BRAVE_API_KEY: 'sk-z' },
  });
  assert.ok('brave-search' in mcpServers);
  assert.deepEqual(env, { BRAVE_API_KEY: 'sk-z' });
});

// ---- reconcilePiMcpDocument: the .pi/mcp.json marker reconcile ----

const cfg = (command: string) => ({ command, lifecycle: 'eager' as const });

test('reconcile: adds managed servers + writes the marker on a fresh doc', () => {
  const out = reconcilePiMcpDocument({}, { playwright: cfg('cmd') });
  assert.deepEqual(out?.mcpServers, { playwright: cfg('cmd') });
  assert.deepEqual(out?.__latticeManagedMcp, ['playwright']);
});

test('reconcile: preserves the user’s own servers, only manages ours', () => {
  const existing = {
    mcpServers: { myServer: { command: 'node' } },
  };
  const out = reconcilePiMcpDocument(existing, { playwright: cfg('cmd') });
  assert.deepEqual(out?.mcpServers, {
    myServer: { command: 'node' },
    playwright: cfg('cmd'),
  });
  assert.deepEqual(out?.__latticeManagedMcp, ['playwright']);
});

test('reconcile: strips a previously-managed server that is now disabled', () => {
  const existing = {
    mcpServers: { myServer: { command: 'node' }, playwright: cfg('cmd'), context7: cfg('cmd') },
    __latticeManagedMcp: ['playwright', 'context7'],
  };
  // Now only context7 is managed → playwright (ours) is removed, myServer (user) stays.
  const out = reconcilePiMcpDocument(existing, { context7: cfg('cmd') });
  assert.deepEqual(Object.keys(out!.mcpServers!).sort(), ['context7', 'myServer']);
  assert.deepEqual(out?.__latticeManagedMcp, ['context7']);
});

test('reconcile: managed→empty strips all ours + drops the marker', () => {
  const existing = {
    mcpServers: { myServer: { command: 'node' }, playwright: cfg('cmd') },
    __latticeManagedMcp: ['playwright'],
  };
  const out = reconcilePiMcpDocument(existing, {});
  assert.deepEqual(out?.mcpServers, { myServer: { command: 'node' } });
  assert.ok(!('__latticeManagedMcp' in out!));
});

test('reconcile: no managed + no prior marker → null (skip the write entirely)', () => {
  assert.equal(reconcilePiMcpDocument({}, {}), null);
  assert.equal(
    reconcilePiMcpDocument({ mcpServers: { userOwn: { command: 'x' } } }, {}),
    null,
  );
});
