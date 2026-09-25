// MCP config import: the minimal Codex TOML reader + `normalizeServer`'s
// secret-classification (security-relevant — a literal key must land in the
// secrets file, not inline in globalSettings.json; a reference stays unstored).
// Split out of the original monolithic mcp.test.ts; adds HTTP-header secret
// coverage for the import header-leak fix, and the url/args embedded-secret fix
// (scan redacts, apply refuses — never written to globalSettings.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyImport,
  normalizeServer,
  parseCodexMcpServers,
  scanImportableServers,
} from '../mcp/importConfigs.js';
import { latticeHomeDir } from '../projectPath.js';

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

// ---- normalizeServer: stdio env secret-classification (security-relevant) ----

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

test('normalize: a literal secret VALUE is stored even when the var name is benign', () => {
  // Regression: a prefixed key (sk-proj-…) under a non-secret-looking name must
  // NOT land inline in globalSettings.json (not 0600) — store it in the secrets
  // file instead, regardless of the var name.
  const n = normalizeServer(
    'svc',
    { command: 'npx', args: ['svc'], env: { OPENAI_ORG: 'sk-proj-abc' } },
    'test',
  );
  assert.ok(n);
  assert.equal(n.secrets.OPENAI_ORG, 'sk-proj-abc'); // → ~/.lattice/mcpSecrets.json
  assert.ok(n.entry.secretEnvVars?.includes('OPENAI_ORG'));
  assert.equal(n.entry.env?.OPENAI_ORG, undefined); // never inline in globalSettings.json
});

test('normalize: value-shape secrets are caught under benign var names', () => {
  const cases: Array<[string, string]> = [
    ['PAT', 'ghp_0123456789abcdefABCDEF0123456789ab'], // GitHub token prefix
    ['SLACK', 'xoxb-123456789012-abcdefghijklmnop'], // Slack bot token prefix
    ['DSN', 'postgres://user:s3cr3t@db.example.com:5432/app'], // credentialed URI
    ['BLOB', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV'], // high-entropy opaque token
  ];
  for (const [name, value] of cases) {
    const n = normalizeServer('svc', { command: 'npx', args: ['svc'], env: { [name]: value } }, 't');
    assert.ok(n, `${name} normalized`);
    assert.equal(n.secrets[name], value, `${name} stored as secret`);
    assert.ok(n.entry.secretEnvVars?.includes(name), `${name} listed as secret env var`);
    assert.equal(n.entry.env?.[name], undefined, `${name} kept out of inline env`);
  }
});

test('normalize: benign config (no secret name or shape) stays inline', () => {
  const n = normalizeServer(
    'svc',
    {
      command: 'npx',
      args: ['svc'],
      // Plain config: a word, a port, a path, a bare URL, an email — none secret.
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
        CONFIG_PATH: '/usr/local/etc/svc.json',
        ENDPOINT: 'https://api.example.com/mcp',
        CONTACT: 'team@example.com',
      },
    },
    't',
  );
  assert.ok(n);
  assert.equal(n.entry.env?.NODE_ENV, 'production');
  assert.equal(n.entry.env?.PORT, '8080');
  assert.equal(n.entry.env?.CONFIG_PATH, '/usr/local/etc/svc.json');
  assert.equal(n.entry.env?.ENDPOINT, 'https://api.example.com/mcp');
  assert.equal(n.entry.env?.CONTACT, 'team@example.com');
  assert.equal(Object.keys(n.secrets).length, 0); // nothing routed to the secrets file
});

test('normalize: runtime is detected from the command; junk is rejected', () => {
  assert.equal(normalizeServer('a', { command: 'uvx', args: [] }, 't')?.entry.runtime, 'uv');
  assert.equal(normalizeServer('b', { command: 'docker', args: [] }, 't')?.entry.runtime, 'docker');
  assert.equal(normalizeServer('c', { command: 'npx', args: [] }, 't')?.entry.runtime, 'node');
  // Neither command nor url → nothing runnable → null.
  assert.equal(normalizeServer('d', {}, 't'), null);
});

// ---- normalizeServer: HTTP transport + header secret-classification ----

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

test('normalize: a literal secret HTTP header is stored, never kept inline', () => {
  // The import header-leak fix: an Authorization header carrying a literal token
  // must route to the secrets file (header-level indirection), not sit inline in
  // the (non-0600) globalSettings.json entry. The header NAME alone (`auth…`)
  // trips the secret classifier.
  const n = normalizeServer(
    'remote',
    {
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer sk-supersecret', Accept: 'application/json' },
    },
    'test',
  );
  assert.ok(n);
  assert.equal(n.secrets.Authorization, 'Bearer sk-supersecret'); // → mcpSecrets.json
  assert.ok(n.entry.secretHeaders?.includes('Authorization'));
  assert.equal(n.entry.headers?.Authorization, undefined); // never inline
  // Plain header survives inline; it isn't a secret.
  assert.equal(n.entry.headers?.Accept, 'application/json');
  assert.ok(!n.entry.secretHeaders?.includes('Accept'));
});

test('normalize: a value-shape secret header under a benign name is still routed out', () => {
  // The header name (`X-Org`) is not secret-looking, but the value is a token
  // prefix — value-shape detection must catch it for headers too.
  const n = normalizeServer(
    'remote',
    { url: 'https://x/mcp', headers: { 'X-Org': 'sk-proj-abcdef', 'X-Trace': 'on' } },
    'test',
  );
  assert.ok(n);
  assert.equal(n.secrets['X-Org'], 'sk-proj-abcdef');
  assert.ok(n.entry.secretHeaders?.includes('X-Org'));
  assert.equal(n.entry.headers?.['X-Org'], undefined);
  // Benign header stays inline.
  assert.equal(n.entry.headers?.['X-Trace'], 'on');
});

test('normalize: a ${reference} HTTP header is recorded but not stored', () => {
  const n = normalizeServer(
    'remote',
    { url: 'https://x/mcp', headers: { 'X-Api-Key': '${input:api-key}' } },
    'test',
  );
  assert.ok(n);
  assert.ok(n.entry.secretHeaders?.includes('X-Api-Key'));
  assert.equal(n.secrets['X-Api-Key'], undefined); // placeholder, nothing stored
  assert.equal(n.entry.headers?.['X-Api-Key'], undefined); // useless placeholder dropped
});

// ---- secrets embedded in url / args (no env/header slot to move them to) ----

test('normalize: a secret embedded in a url is redacted and flagged', () => {
  const cases: Array<[string, string]> = [
    ['https://host.example/mcp?api_key=sk-queryleak123', 'sk-queryleak123'],
    ['https://host.example/mcp?format=json&token=opaqueleak', 'opaqueleak'],
    ['https://alice:tokenleak456@host.example/mcp', 'tokenleak456'],
    ['https://actions.example.com/mcp/sk-ak-pathleak999/sse', 'sk-ak-pathleak999'],
  ];
  for (const [url, secret] of cases) {
    const n = normalizeServer('remote', { url }, 't');
    assert.ok(n, url);
    assert.ok(!n.entry.url?.includes(secret), `${url} → ${n.entry.url}`);
    assert.ok(n.embeddedSecrets.length > 0, `${url} flagged`);
    assert.ok(!JSON.stringify(n.embeddedSecrets).includes(secret), 'findings never carry the value');
  }
  // The non-secret parts survive for display.
  const q = normalizeServer('remote', { url: 'https://host.example/mcp?format=json&token=x1' }, 't');
  assert.equal(q?.entry.url, 'https://host.example/mcp?format=json&token=***');
});

test('normalize: a secret embedded in args is redacted and flagged', () => {
  const cases: Array<[string[], string]> = [
    [['-y', 'some-mcp', '--api-key', 'sk-argleak789'], 'sk-argleak789'],
    [['-y', 'some-mcp', '--api-key=plainleak'], 'plainleak'],
    [['run', '-e', 'API_KEY=dockerleak', 'img'], 'dockerleak'],
    [['-y', 'mcp-remote', 'https://h/sse', '--header', 'Authorization:Bearer hdrleakABC123'], 'hdrleakABC123'],
    [['-y', 'mcp-remote', 'https://bob:urlargleak@h/sse'], 'urlargleak'],
    [['-y', 'svc', 'ghp_0123456789abcdefABCDEF0123456789ab'], 'ghp_0123456789abcdefABCDEF0123456789ab'],
  ];
  for (const [args, secret] of cases) {
    const n = normalizeServer('svc', { command: 'npx', args }, 't');
    assert.ok(n, args.join(' '));
    assert.ok(!n.entry.args?.join(' ').includes(secret), `${args.join(' ')} → ${n.entry.args?.join(' ')}`);
    assert.ok(n.embeddedSecrets.length > 0, `${args.join(' ')} flagged`);
  }
});

test('normalize: plain urls / args and references are not flagged', () => {
  const plainArgs = [
    '-y', '@modelcontextprotocol/server-filesystem', '/home/u/projects',
    '--port', '8080', '--token-file', '/etc/svc/token', '--api-key', '${env:SVC_KEY}',
    'https://api.example.com/mcp',
  ];
  const a = normalizeServer('svc', { command: 'npx', args: plainArgs }, 't');
  assert.deepEqual(a?.entry.args, plainArgs);
  assert.deepEqual(a?.embeddedSecrets, []);
  for (const url of [
    'https://api.example.com/mcp?format=json',
    'https://api.example.com/mcp?api_key=${env:SVC_KEY}',
    'http://localhost:3000/sse',
  ]) {
    const n = normalizeServer('remote', { url }, 't');
    assert.equal(n?.entry.url, url);
    assert.deepEqual(n?.embeddedSecrets, []);
  }
});

// Scan + apply end to end over a real ~/.claude.json (under the isolated home).
const EMBEDDED_SECRETS = {
  query: 'sk-queryleak123',
  userinfo: 'tokenleak456',
  args: 'sk-argleak789',
};

async function withClaudeJson(servers: object, fn: () => Promise<void>): Promise<void> {
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run with the isolateHome preload');
  const claudeJson = path.join(os.homedir(), '.claude.json');
  const prev = await fs.readFile(claudeJson, 'utf8').catch(() => null);
  await fs.writeFile(claudeJson, JSON.stringify({ mcpServers: servers }));
  try {
    await fn();
  } finally {
    if (prev === null) await fs.rm(claudeJson, { force: true });
    else await fs.writeFile(claudeJson, prev);
  }
}

const EMBEDDED_SERVERS = {
  'emb-query': { type: 'http', url: `https://host.example/mcp?api_key=${EMBEDDED_SECRETS.query}` },
  'emb-userinfo': { type: 'http', url: `https://user:${EMBEDDED_SECRETS.userinfo}@host.example/mcp` },
  'emb-args': { command: 'npx', args: ['-y', 'some-mcp', '--api-key', EMBEDDED_SECRETS.args] },
  'emb-plain': { command: 'npx', args: ['-y', 'plain-mcp'] },
};

test('import scan: secrets embedded in url / args are absent from the response', async () => {
  await withClaudeJson(EMBEDDED_SERVERS, async () => {
    const res = await scanImportableServers();
    const body = JSON.stringify(res);
    for (const secret of Object.values(EMBEDDED_SECRETS)) {
      assert.ok(!body.includes(secret), `scan response leaked ${secret}`);
    }
    const byId = new Map(res.servers.map((s) => [s.id, s]));
    for (const id of ['emb-query', 'emb-userinfo', 'emb-args']) {
      assert.ok((byId.get(id)?.embeddedSecrets.length ?? 0) > 0, `${id} flagged`);
    }
    assert.deepEqual(byId.get('emb-plain')?.embeddedSecrets, []);
  });
});

test('import apply: servers with embedded secrets are refused, never written to globalSettings.json', async () => {
  await withClaudeJson(EMBEDDED_SERVERS, async () => {
    const res = await applyImport(Object.keys(EMBEDDED_SERVERS));
    assert.deepEqual(res.imported, ['emb-plain']);
    assert.deepEqual(
      res.refused.map((r) => r.id).sort(),
      ['emb-args', 'emb-query', 'emb-userinfo'],
    );
    for (const r of res.refused) assert.match(r.reason, /env var or HTTP header/);
    const settings = await fs.readFile(path.join(latticeHomeDir(), 'globalSettings.json'), 'utf8');
    assert.ok(settings.includes('emb-plain'), 'the plain server was written');
    for (const secret of Object.values(EMBEDDED_SECRETS)) {
      assert.ok(!settings.includes(secret), `globalSettings.json leaked ${secret}`);
    }
    for (const id of ['emb-query', 'emb-userinfo', 'emb-args']) {
      assert.ok(!settings.includes(`"${id}"`), `${id} must not be written`);
    }
  });
});
