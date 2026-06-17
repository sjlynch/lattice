// Built-in MCP server catalog. These definitions live in CODE (not seeded into
// JSON) so a package-name change is a code update, not a data migration — see
// the MCP plan, decision #5.
//
// INVARIANT: every server ships DISABLED. There is deliberately no
// `enabledByDefault` flag — the registry resolver computes `enabled` purely
// from per-project overrides (`mcpOverrides[id] ?? false`, and `qaPlaywright`
// for Playwright), so a new project loads nothing until the user opts in.
//
// Package names verified June 2026. Gotchas baked in: the official
// `fetch`/`git`/`time` servers are PyPI/`uvx` (not npm); Brave moved to the
// `@brave/` scope (the old `@modelcontextprotocol/server-brave-search` is
// archived); GitHub has no npm package. None of those ship here.

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
  harnessSupport: McpHarnessSupport;
  // Free-text runtime caveat surfaced in the MCP tab (Node version, Chrome, …).
  runtimeNote?: string;
  // True for code-defined catalog entries; user-added customs are false. Built-ins
  // are editable via `mcpBuiltinOverrides` but never deletable.
  builtin?: boolean;
};

// v1 catalog: 4 servers, all disabled until enabled per-project.
export const BUILTIN_MCP_SERVERS: McpServerEntry[] = [
  {
    id: 'playwright',
    label: 'Playwright',
    description:
      'Browser automation for end-to-end / QA testing. Toggle it from the QA ' +
      'lane; the headless switch there controls --headless.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    runtime: 'node',
    runtimeNote: 'First run downloads browsers, so the first QA spawn is slow.',
    harnessSupport: { claude: true, codex: true, pi: false },
    builtin: true,
  },
  {
    id: 'chrome-devtools',
    label: 'Chrome DevTools',
    description:
      'Drive and inspect a real Chrome via the DevTools protocol (network, ' +
      'performance traces, console).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    runtime: 'node',
    runtimeNote: 'Needs Node 22+ and an installed Chrome.',
    harnessSupport: { claude: true, codex: true, pi: false },
    builtin: true,
  },
  {
    id: 'context7',
    label: 'Context7',
    description:
      'Up-to-date, version-specific library docs and code examples. Works on a ' +
      'keyless free tier; an optional API key raises rate limits.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    runtime: 'node',
    harnessSupport: { claude: true, codex: true, pi: false },
    builtin: true,
  },
  {
    id: 'brave-search',
    label: 'Brave Search',
    description:
      'Web and local search via the Brave Search API. Requires a free API key.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    runtime: 'node',
    requiresSecret: {
      envVar: 'BRAVE_API_KEY',
      label: 'Brave Search API key',
      getKeyUrl: 'https://api-dashboard.search.brave.com/app/keys',
    },
    harnessSupport: { claude: true, codex: true, pi: false },
    builtin: true,
  },
];

export function builtinMcpServerById(id: string): McpServerEntry | undefined {
  return BUILTIN_MCP_SERVERS.find((s) => s.id === id);
}
