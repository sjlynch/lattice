// The two Opengrep tools on Lattice's MCP server, driven over the in-memory
// transport with a fake backend (same harness as latticeMcp.test.ts). What is
// pinned: the exact request each tool makes, that the DIGEST MARKDOWN is what
// reaches the model (never the JSON envelope), and that the backend's 409
// (busy / not installed / no rules) is surfaced as an error the agent can act
// on rather than swallowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLatticeMcpServer } from '../latticeMcp/createServer.js';
import type { FetchLike } from '../latticeMcp/client.js';

const PROJECT = 'C:\\development\\lattice';
const API = 'http://127.0.0.1:5184';

type Recorded = { url: string; method: string; body: string | undefined };

async function connect(calls: Recorded[], answer: (url: string) => { status?: number; body: unknown }) {
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const res = answer(url);
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
    };
  };
  const server = createLatticeMcpServer({ apiUrl: API, project: PROJECT, fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content[0]?.text ?? '';
}

const ENVELOPE = {
  canonicalProject: PROJECT,
  scan: { id: 'og_1', findings: 3 },
  digest: { shown: 2, total: 3, rules: 1, bytes: 42 },
  markdown: '# Opengrep findings\n\n**2 findings shown**',
};

test('opengrep_scan POSTs the scan with includeMarkdown and hands the model the digest markdown', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, () => ({ body: ENVELOPE }));
  try {
    const r = await client.callTool({ name: 'opengrep_scan', arguments: { targets: ['backend/src'] } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/api\/opengrep\/scan\?project=/);
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { targets: ['backend/src'], includeMarkdown: true });
    assert.equal(textOf(r), ENVELOPE.markdown, 'the markdown, not the envelope, is the tool result');
    assert.notEqual((r as { isError?: boolean }).isError, true);
  } finally {
    await close();
  }
});

test('opengrep_findings reads a stored scan with the narrowing knobs as query params', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, () => ({ body: ENVELOPE }));
  try {
    await client.callTool({
      name: 'opengrep_findings',
      arguments: { rule: 'xss.foo', file: 'backend/src/a.ts', severity: 'INFO', budgetKb: 120 },
    });
    assert.equal(calls[0].method, 'GET');
    const u = new URL(calls[0].url);
    assert.equal(u.pathname, '/api/opengrep/scans/latest');
    assert.equal(u.searchParams.get('project'), PROJECT);
    assert.equal(u.searchParams.get('include'), 'markdown');
    assert.equal(u.searchParams.get('rule'), 'xss.foo');
    assert.equal(u.searchParams.get('file'), 'backend/src/a.ts');
    assert.equal(u.searchParams.get('severity'), 'INFO');
    assert.equal(u.searchParams.get('budgetKb'), '120');

    calls.length = 0;
    await client.callTool({ name: 'opengrep_findings', arguments: { scan: 'og_9' } });
    assert.equal(new URL(calls[0].url).pathname, '/api/opengrep/scans/og_9');
  } finally {
    await close();
  }
});

test('opengrep_ignore POSTs the rule ids / fingerprints to the ignore route and returns the envelope', async () => {
  const calls: Recorded[] = [];
  const envelope = {
    canonicalProject: PROJECT,
    added: { ruleIds: ['i18next-key-format'], fingerprints: ['62da25210dcc0ac0_0'] },
    ignoreRuleIds: ['i18next-key-format'],
    ignoreFingerprints: ['62da25210dcc0ac0_0'],
  };
  const { client, close } = await connect(calls, () => ({ body: envelope }));
  try {
    const r = await client.callTool({
      name: 'opengrep_ignore',
      arguments: { ruleIds: ['i18next-key-format'], fingerprints: ['opengrep:62da25210dcc0ac0_0'], reason: 'noise' },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/api\/opengrep\/ignore\?project=/);
    // `reason` is for the model's own bookkeeping; only the lists travel.
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), {
      ruleIds: ['i18next-key-format'],
      fingerprints: ['opengrep:62da25210dcc0ac0_0'],
    });
    assert.notEqual((r as { isError?: boolean }).isError, true);
    // The envelope comes back as the first line; the agent's `reason` is
    // echoed beneath it (never sent to the API) so the transcript keeps the why.
    const [first, ...rest] = textOf(r).split('\n');
    assert.deepEqual(JSON.parse(first), envelope);
    assert.deepEqual(rest, ['reason: noise']);
  } finally {
    await close();
  }
});

test('a 409 from the scan route (busy / not installed / no rules) is an error result carrying the reason', async () => {
  const calls: Recorded[] = [];
  const { client, close } = await connect(calls, () => ({
    status: 409,
    body: { error: 'Opengrep is not installed. Install it in Settings → Tools', code: 'not-installed' },
  }));
  try {
    const r = await client.callTool({ name: 'opengrep_scan', arguments: {} });
    assert.equal((r as { isError?: boolean }).isError, true);
    assert.match(textOf(r), /HTTP 409/);
    assert.match(textOf(r), /not installed/);
  } finally {
    await close();
  }
});
