// The MCP server-entry types: the catalog's entries, `globalSettings`'
// `mcpCustomServers` / `mcpBuiltinOverrides`, and `GET /api/mcp-catalog`.
// Types only, and node-free — the frontend's MCP tab re-exports them through
// `../shared/wireTypes.ts`. catalog.ts imports node-reaching runtime (the
// `lattice` entry's path), so the declarations live HERE and catalog.ts
// re-exports them; backend importers keep their old paths.

export type McpRuntime = 'node' | 'uv' | 'docker' | 'remote';

export type McpSecretRequirement = {
  // The environment variable the server reads the key from.
  envVar: string;
  // Human label for the masked field + status chips.
  label: string;
  // Provider dashboard the "Get a key" deep link points at.
  getKeyUrl?: string;
};

export type McpHarnessSupport = {
  claude: boolean;
  codex: boolean;
  pi: boolean;
};

export type McpServerEntry = {
  id: string; // stable slug == the key written into Claude's `mcpServers`
  label: string;
  description: string;
  transport: 'stdio' | 'http';
  command?: string; // stdio
  args?: string[]; // stdio
  env?: Record<string, string>; // static env only; secrets merged at resolve time
  url?: string; // http
  headers?: Record<string, string>; // http
  runtime: McpRuntime; // lets the UI warn "needs uv / Docker"
  // When set, the server needs an API key; the MCP tab renders a masked field
  // + status chip and the resolver injects the stored/ambient value.
  requiresSecret?: McpSecretRequirement;
  // Env vars whose VALUES live in `~/.lattice/mcpSecrets.json` rather than
  // inline here — used by imported custom servers so their keys stay out of
  // globalSettings.json. The resolver injects each from the secrets file (or
  // omits it for ambient inheritance). `requiresSecret.envVar` is implicitly
  // one of these for built-ins.
  secretEnvVars?: string[];
  // HTTP `headers` whose VALUES live in `~/.lattice/mcpSecrets.json` rather than
  // inline in `headers` here — the header analogue of `secretEnvVars`, used by
  // imported HTTP servers so an auth header's literal key (`Authorization:
  // Bearer …`) never sits in the non-0600 globalSettings.json. The resolver
  // re-injects each from the secrets file (keyed by header name) at spawn time.
  secretHeaders?: string[];
  harnessSupport: McpHarnessSupport;
  // Free-text runtime caveat surfaced in the MCP tab (Node version, Chrome, …).
  runtimeNote?: string;
  // True for code-defined catalog entries; user-added customs are false. Built-ins
  // are editable via `mcpBuiltinOverrides` but never deletable.
  builtin?: boolean;
  // Resolve to ON when the project has no explicit per-harness override.
  // RESERVED FOR FIRST-PARTY SERVERS — currently only `lattice`. Never set this
  // on a third-party entry: it would run someone else's package in every agent
  // Lattice spawns, on every project, without the user ever choosing it. See
  // the INVARIANT at the top of catalog.ts, and `registry.harnessToggleOn`.
  // The MCP tab's switches read `overrides[id] ?? !!defaultEnabled`, never
  // treating an absent override as off.
  defaultEnabled?: boolean;
};
