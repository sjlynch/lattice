// The opt-in CONTROLLER mode of Lattice's MCP server (`server.js --controller`,
// or `LATTICE_MCP_MODE=controller`): one server drives any project on one or
// more Lattice instances. Built for experiment orchestration — define workflow
// variants, run them against sandbox projects, wait, export the boards.
//
// The pinned `lattice` server (`createServer.ts`) is untouched by this mode and
// remains the only one task / workflow-step agents ever get; `lattice-control`
// reaches user-started sessions only (mcp/CLAUDE.md, `mcp/userLaunchedScope.ts`).
//
// Every scoped tool takes `instance` (name, or a loopback URL; default the first
// configured) and `project` (absolute path; default LATTICE_PROJECT, on the
// default instance only). The client is built per call for that pair and
// asserts every response against the requested project, exactly like the
// pinned client asserts against its env.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LatticeClient, type FetchLike, type LatticeClientOptions } from './client.js';
import { resolveInstance, type InstanceConfig, type LatticeInstance } from './instances.js';
import { ToolHost, type ScopeArgs, type ToolScope } from './toolHost.js';
import type { ToolResult } from './toolResult.js';
import { registerBoardManagementTools } from './tools/boardManagementTools.js';
import {
  registerApiRequestTool,
  registerInstancesTool,
  registerMergeAndExportTools,
} from './tools/controllerTools.js';
import { registerReadTools } from './tools/readTools.js';
import { registerWorkflowTools } from './tools/workflowTools.js';
import { registerWriteTools } from './tools/writeTools.js';

export type CreateControllerServerOptions = InstanceConfig & {
  // Injectable for tests; default the global `fetch`.
  fetchImpl?: FetchLike;
  // Restart-retry tuning + the polling sleep, passed to every client.
  retry?: LatticeClientOptions['retry'];
  // `wait_workflow_run` poll interval (tests).
  pollIntervalMs?: number;
};

// The board tools the controller offers from the shared tiers: no create_task
// (create_tasks covers it), append_summary, my_task or Opengrep — fewer
// tool definitions in every session that enables it.
const CONTROLLER_BOARD_TOOLS = new Set([
  'board_summary',
  'list_tasks',
  'get_task',
  'search_tasks',
  'create_tasks',
  'update_task',
  'transition_tasks',
  'delete_task',
  'run_task',
]);

// Repeated in ~20 schemas: kept short; the server instructions carry the rest.
const INSTANCE_DESC = 'Instance name or loopback URL (default: first).';
const PROJECT_DESC = 'Absolute project path (default: LATTICE_PROJECT).';

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function unknownInstance(config: InstanceConfig, arg: string): ToolResult {
  const known = config.instances.map((i) => `${i.name} (${i.url})`).join(', ');
  return fail(
    `Unknown Lattice instance ${JSON.stringify(arg)}. Configured: ${known}. ` +
      'Another local instance can be named by URL, e.g. http://localhost:5484.',
  );
}

export function createLatticeControllerServer(opts: CreateControllerServerOptions): McpServer {
  const config: InstanceConfig = { instances: opts.instances, defaultProject: opts.defaultProject };
  const defaultInstance = config.instances[0];

  const clientFor = (instance: LatticeInstance, project: string, retry = opts.retry) =>
    new LatticeClient({
      apiUrl: instance.url,
      project,
      projectSource: 'argument',
      fetchImpl: opts.fetchImpl,
      retry,
    });

  const instanceClient = (arg: string | undefined, o: { retry?: false } = {}) => {
    const instance = resolveInstance(config, arg);
    if (!instance) return unknownInstance(config, arg ?? '');
    return clientFor(instance, '', o.retry === false ? { ...opts.retry, budgetMs: 0 } : opts.retry);
  };

  const instanceShape = { instance: z.string().optional().describe(INSTANCE_DESC) };
  const scope: ToolScope = {
    shape: { ...instanceShape, project: z.string().optional().describe(PROJECT_DESC) },
    resolve(args: ScopeArgs) {
      const instance = resolveInstance(config, args.instance);
      if (!instance) return unknownInstance(config, args.instance ?? '');
      const project =
        args.project?.trim() ||
        (instance.url === defaultInstance.url ? config.defaultProject : undefined);
      if (!project) {
        return fail(
          `project is required (an absolute path) for instance ${instance.name}` +
            (config.defaultProject
              ? ` — the LATTICE_PROJECT default applies to the default instance (${defaultInstance.name}) only.`
              : ' — no default project is configured.'),
        );
      }
      return clientFor(instance, project);
    },
  };

  const instanceList = config.instances
    .map((i, n) => `${i.name}=${i.url}${n === 0 ? ' (default)' : ''}`)
    .join(', ');
  const server = new McpServer(
    { name: 'lattice-control', version: '1.0.0' },
    {
      instructions:
        `Lattice controller over instances ${instanceList}` +
        (config.defaultProject ? `; default project ${config.defaultProject} (default instance only)` : '') +
        '. Tools take optional instance + project (absolute path). Orient with instances, then ' +
        'board_summary before listing a board. One active workflow run per project: ' +
        'start_workflow_run → wait_workflow_run (repeat while done:false) → export_board. ' +
        'api_request reaches any /api/ route.',
    },
  );

  const host = new ToolHost(server, scope, CONTROLLER_BOARD_TOOLS);
  registerInstancesTool(server, { config, instanceClient });
  registerReadTools(host, {});
  registerWriteTools(host, {});
  registerBoardManagementTools(host, { runModelFields: true });
  registerWorkflowTools(new ToolHost(server, scope), { pollIntervalMs: opts.pollIntervalMs });
  registerMergeAndExportTools(new ToolHost(server, scope));
  registerApiRequestTool(server, { config, instanceClient }, instanceShape);
  return server;
}
