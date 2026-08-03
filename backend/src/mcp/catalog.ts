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
};

// v1 catalog: 5 servers, all disabled until enabled per-project.
export const BUILTIN_MCP_SERVERS: McpServerEntry[] = [
  {
    id: 'playwright',
    label: 'Playwright',
    description:
      'Browser automation for end-to-end / QA testing. Enable it per harness, ' +
      'then flip "Show browser" to run it headed (a visible window) when you ' +
      'want to watch. The QA lane has its own separate Playwright toggle.',
    transport: 'stdio',
    command: 'npx',
    // `--isolated` is REQUIRED, not optional: `@playwright/mcp` otherwise reuses
    // ONE shared persistent profile dir (`%LOCALAPPDATA%/ms-playwright-mcp/
    // mcp-chrome-<hash>`), and a SECOND instance wanting it dies with "Browser is
    // already in use … use --isolated to run multiple instances". Lattice injects
    // Playwright into many concurrent sessions (several Pi/Codex/Claude agents, a
    // QA run alongside a sidebar terminal, …), so a shared profile means only one
    // can run at a time. `--isolated` gives each session its own in-memory profile
    // (discarded on close) — no lock, no collision, clean slate per run.
    args: ['-y', '@playwright/mcp@latest', '--isolated'],
    runtime: 'node',
    runtimeNote: 'First run downloads browsers, so the first QA spawn is slow.',
    harnessSupport: { claude: true, codex: true, pi: true },
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
    harnessSupport: { claude: true, codex: true, pi: true },
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
    harnessSupport: { claude: true, codex: true, pi: true },
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
    harnessSupport: { claude: true, codex: true, pi: true },
    builtin: true,
  },
  {
    id: 'blender',
    label: 'Blender',
    description:
      'Drive a running Blender from the agent: inspect the scene, create and ' +
      'modify objects/materials, run Python inside Blender, and pull in assets ' +
      'from Poly Haven / Sketchfab / Hyper3D.',
    transport: 'stdio',
    // PyPI, not npm — `uvx` (like the official fetch/git/time servers). Both
    // `uvx` and `uv` are already in claudeInject's WIN_SHIM_COMMANDS, so all
    // three harness shapers `cmd /c`-wrap this correctly on Windows.
    command: 'uvx',
    args: ['blender-mcp'],
    runtime: 'uv',
    // The server is only half the install: it's a thin bridge that talks to an
    // addon socket on localhost:9876, so a Blender with the addon enabled must
    // already be OPEN or every tool call fails "Could not connect to Blender".
    // The addon refuses to serve under `blender -b` (commands execute on
    // Blender's main thread via bpy.app.timers, which background mode never
    // pumps), so there is deliberately no headless story.
    runtimeNote:
      'Needs the uv package manager on PATH, plus Blender 3.0+ open (not ' +
      'headless) with the "Blender MCP" addon installed and enabled — it ' +
      'auto-starts on localhost:9876. Optional Sketchfab/Hyper3D keys are ' +
      "entered in Blender's own addon preferences, not here.",
    harnessSupport: { claude: true, codex: true, pi: true },
    builtin: true,
  },
];

export function builtinMcpServerById(id: string): McpServerEntry | undefined {
  return BUILTIN_MCP_SERVERS.find((s) => s.id === id);
}
