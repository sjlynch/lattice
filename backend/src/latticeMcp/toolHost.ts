// How a tool reaches its LatticeClient — the one seam that lets the board tool
// implementations in `tools/` serve both server modes without a second copy:
//   - PINNED (the default `lattice` server): one client, fixed project, and the
//     tool's schema exactly as declared — no tool takes `project`.
//   - CONTROLLER (`--controller`, `createControllerServer.ts`): every scoped tool
//     also takes `instance` + `project`, and the client is resolved PER CALL.
//     A resolve failure (unknown instance, no project) is the tool's result.
// `offered` lets the controller register a subset of a registrar's tools.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { LatticeClient } from './client.js';
import type { ToolResult } from './toolResult.js';

export type ScopeArgs = { instance?: string; project?: string };

export type ToolScope = {
  // Extra input fields every scoped tool takes ({} when pinned).
  shape: z.ZodRawShape;
  // The client for one call, or the error result saying why there is none.
  resolve(args: ScopeArgs): LatticeClient | ToolResult;
};

export class ToolHost {
  constructor(
    readonly server: McpServer,
    private readonly scope: ToolScope,
    private readonly offered?: ReadonlySet<string>,
  ) {}

  tool<S extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema: S },
    handler: (client: LatticeClient, args: z.output<z.ZodObject<S>>) => Promise<ToolResult>,
  ): void {
    if (this.offered && !this.offered.has(name)) return;
    const inputSchema: z.ZodRawShape = { ...config.inputSchema, ...this.scope.shape };
    this.server.registerTool(
      name,
      { description: config.description, inputSchema },
      async (args) => {
        const client = this.scope.resolve(args as ScopeArgs);
        if (!(client instanceof LatticeClient)) return client;
        return handler(client, args as z.output<z.ZodObject<S>>);
      },
    );
  }
}

// The pinned scope: always the one client, no extra arguments.
export function pinnedScope(client: LatticeClient): ToolScope {
  return { shape: {}, resolve: () => client };
}
