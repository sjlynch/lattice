// Built-in MCP server catalog. These definitions live in CODE (not seeded into
// JSON) so a package-name change is a code update, not a data migration — see
// the MCP plan, decision #5.
//
// INVARIANT: every THIRD-PARTY server ships DISABLED. The registry resolver
// computes `enabled` from per-project overrides (`mcpOverrides[id]` for Claude,
// `mcpHarnessOverrides[harness][id]` for Codex/Pi, plus `qaPlaywright` for
// Playwright), and with no override the answer is `false` — so a new project
// loads no third-party code, no keys, and no telemetry until the user opts in.
//
// THE SINGLE EXCEPTION is Lattice's OWN first-party server (`lattice`, below),
// which sets `defaultEnabled: true`. It runs Lattice's own code out of this
// repo, needs no secret, talks only to the local backend that spawned the
// session, and IS the feature — a board server nobody switches on is a board
// server nobody uses. An explicit `false` override still turns it off, per
// harness. `defaultEnabled` is reserved for that class of entry and must NEVER
// be set on a third-party server: doing so would silently run somebody else's
// package in every worktree agent on the machine.

//
// Package names verified June 2026. Gotchas baked in: the official
// `fetch`/`git`/`time` servers are PyPI/`uvx` (not npm); Brave moved to the
// `@brave/` scope (the old `@modelcontextprotocol/server-brave-search` is
// archived); GitHub has no npm package. None of those ship here.

import { latticeMcpServerEntryPath } from '../latticeMcp/entryPath.js';

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
  // the INVARIANT at the top of this file, and `registry.harnessToggleOn`.
  defaultEnabled?: boolean;
};

// The id of Lattice's own first-party board server. Referenced by the resolver
// (which injects its per-spawn env) and by the settings UI, so it lives here
// rather than as a string literal in three places.
export const LATTICE_MCP_SERVER_ID = 'lattice';

// The catalog: Lattice's own board server (on by default) followed by the
// third-party servers, all of which stay disabled until enabled per-project.
export const BUILTIN_MCP_SERVERS: McpServerEntry[] = [
  {
    id: LATTICE_MCP_SERVER_ID,
    label: 'Lattice task board',
    description:
      "Typed tools for this project's Lattice task board: board_summary, " +
      'list_tasks, get_task, search_tasks, create/update/delete, transition ' +
      'lanes, append a summary, and run a task in a worktree. First-party (it ' +
      "is Lattice's own code, needs no API key, and talks only to your local " +
      'backend), so unlike every other server here it is ON by default — turn ' +
      'it off per harness with the switches on this row if you would rather ' +
      'agents drive the HTTP API by hand.',
    transport: 'stdio',
    // `process.execPath` — the exact Node binary running this backend — not a
    // bare `node`. The MCP client spawns without a shell, and the harness's
    // PATH is not ours: a `nvm`/`fnm` shim, a Codex session started from a
    // different shell, or a PATH-less service context can all resolve `node` to
    // nothing (or to a version too old for the SDK). The backend is already
    // running on a Node that works, so use that one. It is an absolute path to
    // a real `.exe`, so `platformizeCommand` correctly leaves it unwrapped.
    command: process.execPath,
    // Absolute path to the compiled stdio entry, resolved next to its own
    // module so it is right from `dist/` regardless of the caller's depth.
    args: [latticeMcpServerEntryPath()],
    // `env` is filled in PER SPAWN by the resolver (LATTICE_API_URL +
    // LATTICE_PROJECT) — a static entry can't know which project it serves.
    runtime: 'node',
    harnessSupport: { claude: true, codex: true, pi: true },
    builtin: true,
    // The one first-party exception to the all-off invariant. See the top of
    // this file.
    defaultEnabled: true,
  },
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
    // Telemetry is ON by default upstream (`TelemetryConfig.enabled = True`),
    // posting per-tool-call events to the author's Supabase. Lattice spawns
    // agents unattended and in parallel, so that would phone home on every
    // worktree/workflow spawn without anyone watching — off by default here.
    //
    // This is NOT redundant with the addon's "Allow Telemetry" checkbox: that
    // consent only gates the PRIVATE payload (prompt text — which is what the
    // required `user_prompt` tool argument feeds — plus code snippets, scene
    // info, and viewport screenshots uploaded to their storage bucket);
    // anonymous per-call events ship regardless. Worse, the addon's consent
    // getter FAILS OPEN — `get_telemetry_consent` returns `True` whenever the
    // preferences lookup misses (`addons.get(__name__)` → None, or
    // AttributeError/KeyError) — so a rename/reinstall that breaks that lookup
    // silently starts uploading prompts and screenshots. The env var is checked
    // in the server's own constructor and clears `config.enabled`, which gates
    // both `record_event` AND `upload_screenshot`, so it holds either way.
    //
    // All three names are set because the server accepts any of them; keeping
    // the full set means an upstream rename can't quietly re-enable sending.
    env: {
      DISABLE_TELEMETRY: 'true',
      BLENDER_MCP_DISABLE_TELEMETRY: 'true',
      MCP_DISABLE_TELEMETRY: 'true',
    },
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
