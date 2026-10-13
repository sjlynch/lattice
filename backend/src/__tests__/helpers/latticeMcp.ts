// Shared harness for the split latticeMcp.* suites (surface, reads, writes,
// failures, controller*): Lattice's own first-party MCP server (`backend/src/latticeMcp/`),
// driven end to end over the SDK's in-memory transport with a fake `fetchImpl`
// standing in for the backend. That combination is the point: it exercises the
// REAL tool registry, the real zod schemas and the real result shaping, while
// pinning the exact HTTP request each tool makes — which is the contract the
// routes are written to. Not a `*.test.ts` file, so it isn't collected as a suite.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLatticeMcpServer } from '../../latticeMcp/createServer.js';
import { createLatticeControllerServer } from '../../latticeMcp/createControllerServer.js';
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

// The controller-mode server (`createControllerServer.ts`) over the same
// in-memory pair. `answer` routes each request (method + parsed URL) to a
// canned response; sleeps are instant and recorded, so polling costs no time.
export const EXP = 'http://127.0.0.1:5484';
export const SANDBOX = 'C:\\sandbox\\a';

export async function connectController(
  calls: Recorded[],
  answer: (req: { method: string; url: URL; body: unknown }) => CannedResponse | Promise<CannedResponse>,
  opts: { defaultProject?: string; sleeps?: number[]; retryBudgetMs?: number } = {},
) {
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const res = await answer({
      method: init?.method ?? 'GET',
      url: new URL(url),
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
    };
  };
  const server = createLatticeControllerServer({
    instances: [
      { name: 'main', url: API },
      { name: 'exp', url: EXP },
    ],
    defaultProject: opts.defaultProject,
    fetchImpl,
    retry: { budgetMs: opts.retryBudgetMs ?? 0, sleep: async (ms) => void opts.sleeps?.push(ms) },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

// Parse a tool result's text block as JSON.
export function jsonOf(result: unknown): any {
  return JSON.parse(textOf(result));
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
