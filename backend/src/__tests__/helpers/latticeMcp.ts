// Shared harness for the split latticeMcp.* suites (surface, reads, writes,
// failures): Lattice's own first-party MCP server (`backend/src/latticeMcp/`),
// driven end to end over the SDK's in-memory transport with a fake `fetchImpl`
// standing in for the backend. That combination is the point: it exercises the
// REAL tool registry, the real zod schemas and the real result shaping, while
// pinning the exact HTTP request each tool makes — which is the contract the
// routes are written to. Not a `*.test.ts` file, so it isn't collected as a suite.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLatticeMcpServer } from '../../latticeMcp/createServer.js';
import type { FetchLike } from '../../latticeMcp/client.js';

export const PROJECT = 'C:\\development\\lattice';
export const API = 'http://127.0.0.1:5184';

// Every request the fake fetch saw, in order.
export type Recorded = { url: string; method: string; body: string | undefined };

type CannedResponse = { status?: number; body: unknown };

// A `fetchImpl` that records each call and answers with a canned envelope. The
// default envelope echoes `canonicalProject`, so the client's project assertion
// runs on the happy path too (a regression there would otherwise pass every
// test silently).
function fakeFetch(
  calls: Recorded[],
  canned: CannedResponse | (() => CannedResponse | Promise<never>) = {
    body: { canonicalProject: PROJECT, ok: true },
  },
): FetchLike {
  return async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const res = typeof canned === 'function' ? await canned() : canned;
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        typeof res.body === 'string' ? res.body : JSON.stringify(res.body),
    };
  };
}

// Wire a real server to a real client over the in-memory pair. Returns both plus
// the recorded-request array; the caller closes via the returned `close`.
export async function connect(
  calls: Recorded[],
  canned?: CannedResponse | (() => CannedResponse | Promise<never>),
  // `taskId` makes this a task-worktree session (what LATTICE_TASK_ID does for
  // the real stdio entry): `my_task` appears and `append_summary` gains a default.
  opts: { taskId?: string } = {},
) {
  const server = createLatticeMcpServer({
    apiUrl: API,
    project: PROJECT,
    taskId: opts.taskId,
    fetchImpl: fakeFetch(calls, canned),
    // No restart retry here: these tests pin single-round-trip outcomes (the
    // retry has its own tests in latticeMcp.failures.test.ts).
    retry: { budgetMs: 0 },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

// Narrow a CallToolResult's first text block.
export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const first = content[0];
  assert.equal(first?.type, 'text', 'result carries a text block');
  return first?.text ?? '';
}

export function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}
