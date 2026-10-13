// Controller mode's own tools (beyond the shared board tiers and
// `workflowTools.ts`): `instances`, the merge-run pair, `export_board` and the
// `api_request` escape hatch. Registration order is what the model sees.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { atomicWriteFile } from '../../fsAtomic.js';
import { LatticeClient } from '../client.js';
import type { InstanceConfig } from '../instances.js';
import type { ToolHost } from '../toolHost.js';
import { toToolResult, type ToolResult } from '../toolResult.js';

// `api_request` keeps at most this much of a response body inline.
const RAW_BODY_LIMIT_BYTES = 64 * 1024;

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

type ControllerToolDeps = {
  config: InstanceConfig;
  // The instance-level client (`instances`, `api_request`): no project, so no
  // `project=` and no project assertion; the error result when `instance`
  // names nothing. `retry: false` skips the restart-retry budget.
  instanceClient: (instance: string | undefined, opts?: { retry?: false }) => LatticeClient | ToolResult;
};

// `instances` — first, so an agent can orient before naming anything.
export function registerInstancesTool(server: McpServer, deps: ControllerToolDeps): void {
  server.registerTool(
    'instances',
    {
      description:
        'The configured Lattice instances (the first is the default) with reachability ' +
        "and each one's known projects. Start here.",
      inputSchema: {},
    },
    async () => {
      const rows = await Promise.all(
        deps.config.instances.map(async (instance, i) => {
          const row: Record<string, unknown> = { name: instance.name, url: instance.url };
          if (i === 0) {
            row.default = true;
            if (deps.config.defaultProject) row.defaultProject = deps.config.defaultProject;
          }
          // No restart retry here: a down instance must not stall the listing.
          const client = deps.instanceClient(instance.name, { retry: false }) as LatticeClient;
          const health = await client.call('/api/health');
          if (health.kind !== 'ok') return { ...row, reachable: false, error: health.text };
          const projects = await client.call('/api/projects');
          let paths: unknown = projects.text;
          if (projects.kind === 'ok') {
            try {
              paths = (JSON.parse(projects.text) as { path?: unknown }[]).map((p) => p?.path);
            } catch {
              /* keep the raw text */
            }
          }
          return { ...row, reachable: true, projects: paths };
        }),
      );
      return ok(rows);
    },
  );
}

export function registerMergeAndExportTools(host: ToolHost): void {
  host.tool(
    'start_merge_run',
    {
      description:
        "Merge every Ready-to-Merge task into the project's main branch (one merge run per " +
        'project; 409 while one or a post-merge hook is active). Poll get_merge_run.',
      inputSchema: {},
    },
    async (client) => toToolResult(await client.call('/api/merge-runs', { method: 'POST', body: {} })),
  );

  host.tool(
    'get_merge_run',
    {
      description:
        "A merge run by id, or (no id) the project's active one: status, processed/total, " +
        'merged / conflicted / errored task ids.',
      inputSchema: { id: z.string().optional().describe('Merge run id; omit for the active run.') },
    },
    async (client, { id }) => {
      const outcome = await client.call(id ? `/api/merge-runs/${encodeURIComponent(id)}` : '/api/merge-runs/active');
      if (outcome.kind === 'ok' && outcome.text === 'null') {
        return { content: [{ type: 'text', text: `No active merge run for ${client.project}.` }] };
      }
      return toToolResult(outcome);
    },
  );

  host.tool(
    'export_board',
    {
      description:
        'Every task of the project in every lane (done, qa and deleted included) with full, ' +
        'unclipped descriptions and summaries. With outFile the JSON is written there and only ' +
        'the path and counts come back; inline, a board over 256 KB returns the narrowing 413.',
      inputSchema: {
        outFile: z.string().optional().describe('Absolute path of the JSON file to write.'),
        confirm_large: z.boolean().optional().describe('Inline only: accept a response over 256 KB.'),
      },
    },
    async (client, { outFile, confirm_large }) => {
      if (outFile !== undefined && !path.isAbsolute(outFile)) {
        return fail(`outFile must be an absolute path, got ${JSON.stringify(outFile)}.`);
      }
      const outcome = await client.call('/api/tasks', {
        query: {
          status: 'all',
          fields: 'full',
          clip: 0,
          limit: 0,
          confirm_large: outFile || confirm_large ? 1 : undefined,
        },
      });
      if (!outFile || outcome.kind !== 'ok') return toToolResult(outcome);
      let envelope: { tasks?: { status?: string }[] };
      try {
        envelope = JSON.parse(outcome.text) as typeof envelope;
      } catch {
        return fail(`Unexpected non-JSON board response: ${outcome.text.slice(0, 500)}`);
      }
      const tasks = envelope.tasks ?? [];
      const byStatus: Record<string, number> = {};
      for (const t of tasks) byStatus[t.status ?? '?'] = (byStatus[t.status ?? '?'] ?? 0) + 1;
      const doc = JSON.stringify({ exportedAt: new Date().toISOString(), instance: client.apiUrl, ...envelope }, null, 2);
      try {
        await fs.mkdir(path.dirname(outFile), { recursive: true });
        await atomicWriteFile(outFile, doc);
      } catch (err) {
        return fail(`Could not write ${outFile}: ${(err as Error).message}`);
      }
      return ok({ outFile, bytes: Buffer.byteLength(doc), count: tasks.length, byStatus });
    },
  );
}

// `api_request` — last: the escape hatch for any route the typed tools lack.
export function registerApiRequestTool(server: McpServer, deps: ControllerToolDeps, instanceShape: z.ZodRawShape): void {
  server.registerTool(
    'api_request',
    {
      description:
        'Escape hatch: call any Lattice HTTP route under /api/ directly. No project is ' +
        'added — pass it in query or body as the route expects. Returns the status and ' +
        'body (cut at 64 KB). Prefer the typed tools.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']).optional().describe('Default GET.'),
        path: z.string().describe('Route path starting with /api/, without a query string.'),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional().describe('JSON request body.'),
        ...instanceShape,
      },
    },
    async (args) => {
      const { method = 'GET', path: apiPath, query, body, instance } = args as {
        method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        path: string;
        query?: Record<string, string | number | boolean>;
        body?: unknown;
        instance?: string;
      };
      // The RESOLVED path must stay under /api/ (`/api/../x`, `%2e%2e`, `\`).
      let resolved: URL;
      try {
        resolved = new URL(apiPath, 'http://lattice.invalid');
      } catch {
        resolved = new URL('http://lattice.invalid/');
      }
      if (!apiPath.startsWith('/api/') || !resolved.pathname.startsWith('/api/') ||
          resolved.search || resolved.hash || resolved.host !== 'lattice.invalid') {
        return fail(`path must be an /api/ route without a query string (use query), got ${JSON.stringify(apiPath)}.`);
      }
      const client = deps.instanceClient(instance);
      if (!(client instanceof LatticeClient)) return client;
      const out = await client.request(resolved.pathname, { method, query, body });
      if (out.kind !== 'response') return fail(out.text);
      let text = out.raw;
      try {
        text = JSON.stringify(JSON.parse(out.raw));
      } catch {
        /* not JSON — keep the raw body */
      }
      const bytes = Buffer.byteLength(text);
      if (bytes > RAW_BODY_LIMIT_BYTES) {
        text =
          Buffer.from(text).subarray(0, RAW_BODY_LIMIT_BYTES).toString('utf8') +
          `\n…[truncated: first ${RAW_BODY_LIMIT_BYTES} of ${bytes} bytes]`;
      }
      return {
        content: [{ type: 'text', text: `HTTP ${out.status}\n${text}` }],
        ...(out.ok ? {} : { isError: true }),
      };
    },
  );
}
