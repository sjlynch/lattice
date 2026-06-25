// MCP config import: the minimal Codex TOML reader + `normalizeServer`'s
// secret-classification (security-relevant — a literal key must land in the
// secrets file, not inline in globalSettings.json; a reference stays unstored).
// Split out of the original monolithic mcp.test.ts; adds HTTP-header secret
// coverage for the import header-leak fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexMcpServers, normalizeServer } from '../mcp/importConfigs.js';

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
