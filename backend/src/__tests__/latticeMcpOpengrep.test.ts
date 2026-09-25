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
  return connectFetch(fetchImpl);
}

// Same, around a raw fetch (to throw transport errors), with an INSTANT sleep so
// the scan poll loop costs no wall-clock time.
async function connectFetch(fetchImpl: FetchLike) {
  const server = createLatticeMcpServer({
    apiUrl: API,
    project: PROJECT,
    fetchImpl,
    retry: { budgetMs: 0, sleep: async () => {} },
  });
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
    // `async: true` — a long scan answers 202 + id and is polled (see below);
    // this one finished inside the accept window, so one round trip.
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { targets: ['backend/src'], includeMarkdown: true, async: true });
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

// ---- long scans: 202 + poll, and the undici response timeout ----------------

const RUNNING = { canonicalProject: PROJECT, scanId: 'og_long', status: 'running' };

test('a scan that outlives the accept window answers 202 + id; the tool polls the scan until the digest is ready', async () => {
  const calls: Recorded[] = [];
  let polls = 0;
  const { client, close } = await connect(calls, (url) => {
    if (url.includes('/api/opengrep/scan?')) return { status: 202, body: RUNNING };
    polls += 1;
    return polls < 3 ? { status: 202, body: RUNNING } : { body: ENVELOPE };
  });
  try {
    const r = await client.callTool({ name: 'opengrep_scan', arguments: {} });
    assert.equal(textOf(r), ENVELOPE.markdown);
    assert.notEqual((r as { isError?: boolean }).isError, true);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls.length, 4, 'one POST, then GETs until the scan was no longer running');
    for (const c of calls.slice(1)) {
      const u = new URL(c.url);
      assert.equal(c.method, 'GET');
      assert.equal(u.pathname, '/api/opengrep/scans/og_long');
      assert.equal(u.searchParams.get('include'), 'markdown');
    }
  } finally {
    await close();
  }
});

test('a polled scan that failed, or that the backend no longer knows, is an error result saying so', async () => {
  {
    const { client, close } = await connect([], (url) =>
      url.includes('/api/opengrep/scan?')
        ? { status: 202, body: RUNNING }
        : { status: 500, body: { error: 'opengrep scan timed out after 600s and was killed', code: 'scan-failed' } },
    );
    try {
      const r = await client.callTool({ name: 'opengrep_scan', arguments: {} });
      assert.equal((r as { isError?: boolean }).isError, true);
      assert.match(textOf(r), /HTTP 500/);
      assert.match(textOf(r), /timed out after 600s/);
    } finally {
      await close();
    }
  }
  {
    const { client, close } = await connect([], (url) =>
      url.includes('/api/opengrep/scan?')
        ? { status: 202, body: RUNNING }
        : { status: 404, body: { error: 'no Opengrep scan og_long for this project' } },
    );
    try {
      const r = await client.callTool({ name: 'opengrep_scan', arguments: {} });
      assert.equal((r as { isError?: boolean }).isError, true);
      assert.match(textOf(r), /no longer known/);
      assert.match(textOf(r), /opengrep_scan again/);
    } finally {
      await close();
    }
  }
});

test('an undici headers timeout on the scan POST says the scan is still running and points at opengrep_findings — not "Is Lattice running?"', async () => {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url.includes('/api/opengrep/scan?')) {
      const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
      err.cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
      throw err;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(ENVELOPE) };
  };
  const { client, close } = await connectFetch(fetchImpl);
  try {
    const r = await client.callTool({ name: 'opengrep_scan', arguments: {} });
    const text = textOf(r);
    assert.doesNotMatch(text, /Is Lattice running\?/);
    assert.doesNotMatch(text, /Could not reach/);
    assert.match(text, /still running/);
    assert.match(text, /opengrep_findings/);
    assert.match(text, /latest/);
    assert.equal(calls.length, 1, 'the POST is not re-sent (it may have been acted on)');
  } finally {
    await close();
  }
});

test('opengrep_findings on the id of a scan still running says so instead of returning the 202 body', async () => {
  const { client, close } = await connect([], () => ({ status: 202, body: RUNNING }));
  try {
    const r = await client.callTool({ name: 'opengrep_findings', arguments: { scan: 'og_long' } });
    assert.notEqual((r as { isError?: boolean }).isError, true);
    assert.match(textOf(r), /og_long is still running/);
  } finally {
    await close();
  }
});
