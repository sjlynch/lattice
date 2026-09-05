// The thin HTTP layer under the Lattice MCP server's tools. Every tool call
// funnels through `LatticeClient.call`, which:
//   1. builds the URL against `LATTICE_API_URL` with `project` PINNED from
//      `LATTICE_PROJECT` — so no tool ever takes a `project` argument and an
//      agent can't aim a write at the wrong board,
//   2. sends/parses JSON,
//   3. asserts the response envelope's `canonicalProject` matches the pinned
//      project (see `assertCanonicalProject`), and
//   4. classifies the outcome into the small union `createServer.ts` maps onto
//      MCP results.
//
// The classification is the interesting part, because the three failure shapes
// need three DIFFERENT MCP results:
//   - HTTP 413 is NOT an error. It is the progressive-disclosure teaching
//     response (the board summary + the suggestions that narrow the query), and
//     the agent has to READ it. An `isError` result invites a retry of the same
//     oversized call instead.
//   - A connection failure is an error whose only useful content is "this URL
//     didn't answer; Lattice may not be running" — the agent should stop
//     calling board tools, not narrow its query.
//   - Any other non-2xx is an error carrying the status + body so the agent can
//     tell a 400 (its own bad argument) from a 404/500.
//
// No MCP types are imported here on purpose: this module stays a plain HTTP
// client so it can be unit-tested (and reasoned about) without a transport.

import { canonicalProjectPath } from '../projectPath.js';

// The subset of `fetch` this client uses. Injectable so tests can drive the
// tools against canned envelopes with no server (and no network) at all.
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type LatticeClientOptions = {
  // e.g. `http://127.0.0.1:5184` (trailing slash tolerated).
  apiUrl: string;
  // The canonical project path this server is pinned to.
  project: string;
  fetchImpl?: FetchLike;
};

// What one HTTP round trip produced, in the four shapes the MCP layer renders
// differently. `text` is always the exact string to hand the model.
export type LatticeCallOutcome =
  // 2xx — `text` is the compact JSON envelope.
  | { kind: 'ok'; text: string }
  // HTTP 413 response-too-large — a NORMAL result (summary + suggestions).
  | { kind: 'oversize'; text: string }
  // The backend never answered (ECONNREFUSED, DNS, abort).
  | { kind: 'unreachable'; text: string }
  // Any other non-2xx.
  | { kind: 'httpError'; text: string }
  // The envelope came back for a different project than we pinned.
  | { kind: 'projectMismatch'; text: string };

export type LatticeCallInit = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  // Extra query params. `undefined`/`null` values are dropped, so a tool can
  // spread its optional args in without inventing defaults.
  query?: Record<string, string | number | boolean | undefined | null>;
  // JSON request body (sent with `content-type: application/json`).
  body?: unknown;
};

export class LatticeClient {
  private readonly apiUrl: string;
  readonly project: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: LatticeClientOptions) {
    // Strip trailing slashes once so path joins stay single-slashed.
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.project = opts.project;
    // Default to the ambient global fetch (Node 18+). Wrapped rather than
    // referenced so an unbound `globalThis.fetch` can't throw "Illegal
    // invocation".
    this.fetchImpl =
      opts.fetchImpl ??
      ((input, init) => fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>);
  }

  // `path` is the API path only (`/api/tasks`); `project` is appended here so
  // no caller can forget it.
  buildUrl(path: string, query: LatticeCallInit['query'] = {}): string {
    const params = new URLSearchParams();
    params.set('project', this.project);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    return `${this.apiUrl}${path}?${params.toString()}`;
  }

  async call(path: string, init: LatticeCallInit = {}): Promise<LatticeCallOutcome> {
    const url = this.buildUrl(path, init.query);
    const method = init.method ?? 'GET';
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      // The one failure the agent cannot fix by changing its arguments.
      return {
        kind: 'unreachable',
        text:
          `Could not reach the Lattice backend at ${this.apiUrl} ` +
          `(${method} ${path}): ${(err as Error).message}. Is Lattice running?`,
      };
    }

    const raw = await res.text().catch(() => '');
    const parsed = parseJson(raw);

    if (res.status === 413) {
      // The teaching response. Hand it back verbatim (compact) — it carries the
      // board summary and the exact narrowing suggestions.
      return { kind: 'oversize', text: compact(parsed, raw) };
    }
    if (!res.ok) {
      return {
        kind: 'httpError',
        text: `Lattice API ${method} ${path} failed with HTTP ${res.status}: ${raw || '(empty body)'}`,
      };
    }

    const mismatch = assertCanonicalProject(this.project, parsed);
    if (mismatch) return { kind: 'projectMismatch', text: mismatch };

    return { kind: 'ok', text: compact(parsed, raw) };
  }
}

// Re-serialize a parsed envelope without indentation (the contract's wire
// shape), falling back to the raw body for a non-JSON response. Going through
// the parse guarantees no pretty-printing sneaks in from the server side.
function compact(parsed: unknown, raw: string): string {
  if (parsed === undefined) return raw;
  try {
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

function parseJson(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Envelope-level project assertion. The Lattice list/summary/search envelopes
// echo a `canonicalProject`; when one is present it MUST match the project this
// server is pinned to. This replaces the manual "check the canonicalProject
// field" ritual the HTTP docs make every agent perform by hand — get it wrong
// and you are reading (or worse, mutating) another repo's board.
//
// Comparison: canonicalize both sides, then normalize `\` to `/`, drop trailing
// slashes, and case-fold. Windows paths are case-insensitive but only
// case-PRESERVING, so an exact compare would false-alarm on `c:\x` vs `C:\x`;
// a false alarm here blocks every tool call, which is far worse than the
// theoretical POSIX `/a` vs `/A` pair this tolerates.
//
// Returns an explanatory message on mismatch, or `null` when it matches (or the
// envelope carries no `canonicalProject` — many endpoints return a bare Task).
export function assertCanonicalProject(
  pinnedProject: string,
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const claimed = (payload as { canonicalProject?: unknown }).canonicalProject;
  if (typeof claimed !== 'string' || !claimed) return null;
  if (normalizeForCompare(claimed) === normalizeForCompare(pinnedProject)) return null;
  return (
    `Project mismatch: this Lattice MCP server is pinned to ${pinnedProject}, ` +
    `but the backend answered for ${claimed}. Refusing the result — the ` +
    `LATTICE_PROJECT this server was started with does not match the board the ` +
    `Lattice backend resolved. Do not retry; report this to the user.`
  );
}

function normalizeForCompare(p: string): string {
  return canonicalProjectPath(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
