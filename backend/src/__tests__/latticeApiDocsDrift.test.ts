import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { mountRouteFactories } from '../server/app.js';

// `latticeApiDocs.ts` guarantees a project's `.lattice/LATTICE_API.md` matches
// the TEMPLATE that shipped with this build (content-hash stamped in line 1).
// Nothing guaranteed the template matches the actual ROUTER — so an endpoint
// could be renamed or removed and every agent-facing cheatsheet on every
// machine would keep confidently documenting the dead path.
//
// These tests close that loop by building the real Express app in-process and
// diffing its route table against the hand-maintained docs:
//
//   1. no-broken-links — every path the docs mention must be a live route
//   2. coverage        — every live route must be documented OR explicitly
//                        listed below as intentionally undocumented
//
// (2) is the one that actually prevents drift: adding a route fails this suite
// until the author decides whether agents should know about it. That's a
// deliberate speed bump, not an oversight — if you're here because a new route
// broke the build, add a row to the endpoint table or an entry to
// UNDOCUMENTED_ROUTES with a reason.

// The agent doc is TWO templates since the progressive-disclosure split — a
// short index and the recipes file it points at, with the endpoint table living
// in the latter. Both are read here and their rows / recipe URLs unioned, so
// moving material between them can never quietly drop it out of drift cover.
const TEMPLATE_PATHS = [
  'LATTICE_API.template.md',
  'LATTICE_API_RECIPES.template.md',
].map((name) => fileURLToPath(new URL(`../latticeApiDocs/${name}`, import.meta.url)));
const ROOT_CLAUDE_MD = fileURLToPath(new URL('../../../CLAUDE.md', import.meta.url));

// ---------------------------------------------------------------- route table

type ExpressLayer = {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
  regexp?: RegExp & { fast_slash?: boolean };
};

// Walk the mounted router stack. Every Lattice router is mounted with a bare
// `app.use(router)` and registers absolute `/api/...` paths, so a route layer's
// own path IS the full path. `fast_slash` is Express's marker for exactly that
// prefix-less mount — if someone starts mounting at a prefix, fail loudly here
// rather than silently reporting truncated paths.
function collectRoutes(): Set<string> {
  const app = express();
  mountRouteFactories(app, {
    defaultRoot: process.cwd(),
    backendOrigin: 'http://127.0.0.1:5184',
  });

  const found = new Set<string>();
  const walk = (stack: ExpressLayer[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path];
        for (const p of paths) {
          for (const method of Object.keys(layer.route.methods)) {
            if (method !== '_all') found.add(`${method.toUpperCase()} ${p}`);
          }
        }
      } else if (layer.handle?.stack) {
        assert.ok(
          !layer.regexp || layer.regexp.fast_slash,
          `router mounted at a path prefix (${layer.regexp}) — collectRoutes() ` +
            'assumes prefix-less mounts and would report truncated paths; ' +
            'teach it to accumulate prefixes',
        );
        walk(layer.handle.stack);
      }
    }
  };
  walk((app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack);
  return found;
}

// Param names differ between a route (`:id`) and a doc recipe (`$id`, `%ID%`),
// and between two equivalent routes (`:id` vs `:runId`). Collapse them all so
// paths compare structurally.
function normalizePath(p: string): string {
  return p
    .split('/')
    .map((seg) =>
      seg.startsWith(':') || seg.startsWith('$') || /^%.+%$/.test(seg)
        ? ':param'
        : seg,
    )
    .join('/');
}

const ROUTES = collectRoutes();
const ROUTE_PATHS = new Set([...ROUTES].map((r) => r.slice(r.indexOf(' ') + 1)));
const NORMALIZED_ROUTES = new Set([...ROUTES].map((r) => {
  const i = r.indexOf(' ');
  return `${r.slice(0, i)} ${normalizePath(r.slice(i + 1))}`;
}));
const NORMALIZED_ROUTE_PATHS = new Set([...ROUTE_PATHS].map(normalizePath));

// ------------------------------------------------------------- doc extraction

// Both templates, concatenated. The extractors below are line/row oriented, so
// a plain join is enough to union what the two files document.
function readTemplate(): string {
  return TEMPLATE_PATHS.map((p) =>
    fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n'),
  ).join('\n');
}

// Rows of the template's "Endpoint reference" table:
//   | GET    | /api/tasks?project=&status= | ... |
// The query-string suffix is documentation for the caller, not part of the
// route, so it's stripped.
function endpointTableRows(markdown: string): Array<{ method: string; path: string }> {
  const rows: Array<{ method: string; path: string }> = [];
  const re = /^\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`?(\/api\/[^\s|`]*)`?\s*\|/gm;
  for (const m of markdown.matchAll(re)) {
    rows.push({ method: m[1], path: m[2].split('?')[0].replace(/\/$/, '') });
  }
  return rows;
}

// Every URL a copy-pasteable recipe builds. The template carries the literal
// API base as the {{API_URL}} placeholder (interpolated per project when the
// doc is generated), so that is what prefixes a recipe URL here:
//   "{{API_URL}}/api/tasks/$id"   "{{API_URL}}/api/tasks/batch"
function recipeUrlPaths(markdown: string): string[] {
  const paths = new Set<string>();
  for (const m of markdown.matchAll(/\{\{API_URL\}\}(\/[^\s"'`\\]*)/g)) {
    const p = m[1].split('?')[0].replace(/\/$/, '');
    if (p.startsWith('/api/')) paths.add(p);
  }
  return [...paths];
}

// ------------------------------------------------- intentionally undocumented
//
// LATTICE_API.md is an agent-facing cheatsheet, not an exhaustive API dump.
// A route belongs here when an agent driving the board should NOT be reaching
// for it. Keep the reason next to the entry — it's the whole point of the list.

const UNDOCUMENTED_ROUTES: Record<string, string> = {
  // Machine callbacks. Lattice's own Stop hooks / completion extensions fire
  // these; an agent hand-calling one desynchronizes the pipeline.
  'POST /api/tasks/:id/complete': 'Stop-hook callback (in_progress → ready_to_merge)',
  'POST /api/tasks/:id/merged': 'resolver-Claude callback',
  'POST /api/tasks/:id/merge-aborted': 'resolver-Claude callback',
  'POST /api/tasks/:id/stash-resolved': 'snapshot-conflict resolver callback',
  'POST /api/tasks/:id/activity': 'PreToolUse/PostToolUse hook → graph focus beam',
  'POST /api/merge-runs/:id/stash-resolved': 'post-run snapshot resolver callback',
  'POST /api/workflow-runs/:runId/steps/:stepIndex/complete': 'workflow step Stop hook',
  'POST /api/workflow-prompt-customizations/:id/complete': 'prompt-customization callback',
  'POST /api/post-merge-hooks/:id/complete': 'post-merge hook Stop-hook callback',
  'POST /api/push-runs/:id/done': 'push-run Stop-hook callback',
  'POST /api/qa-runs/:id/done': 'QA-run Stop-hook backstop',
  'POST /api/qa-runs/:id/verdict': 'QA-run structured verdict callback',
  'POST /api/agent-activity/:token': 'HMAC-token activity hook (non-worktree session)',
  'POST /api/project-activity/:token': 'HMAC-token activity hook (project-instrumented session)',
  'POST /api/project-instrumentation': 'install/remove project Claude hooks on project open',

  // Run types the human starts from the board. An agent spawning these would
  // be spawning nested agents behind the user's back.
  'GET /api/git-check': 'repo probe behind the QA-lane Push button',
  'POST /api/push-runs': 'push session — user-initiated from the QA lane',
  'GET /api/push-runs/:id': 'push-run status poll (UI)',
  'DELETE /api/push-runs/:id': 'forget a completed push-run (UI)',
  'POST /api/qa-runs': 'QA e2e session — user-initiated from the QA lane',
  'GET /api/qa-runs/:id': 'QA-run status poll (UI)',
  'DELETE /api/qa-runs/:id': 'forget a completed QA-run (UI)',
  'GET /api/post-merge-hooks/active': 'post-merge hook state for UI rehydration',
  'POST /api/post-merge-hooks/:id/abort': 'abort an active post-merge hook (UI)',
  'POST /api/workflow-prompt-customizations': 'spawns a harness to tailor a step prompt (UI)',
  'GET /api/workflow-prompt-customizations/:id': 'prompt-customization poll (UI)',

  // Git Setup. Creating a repo (and choosing what its first commit captures)
  // is a decision the human makes in the dialog — an agent silently running it
  // would commit whatever happened to be lying in the folder.
  'POST /api/project-init/preview': 'first-commit preview for the Git Setup dialog (UI)',
  'POST /api/project-init': 'git init + first commit — user-confirmed from the Git Setup dialog',

  // Workflow authoring. Editing a user's saved workflows is a UI action, not
  // something an agent should do while working a task.
  'POST /api/workflows': 'workflow-definition create (editor UI)',
  'PATCH /api/workflows/:id': 'workflow-definition update (editor UI)',
  'DELETE /api/workflows/:id': 'workflow-definition delete (editor UI)',

  // Settings / configuration surfaces. Deliberately not advertised — the MCP
  // secret routes especially should not be in a doc every agent reads.
  'GET /api/global-settings': 'machine-global settings (Settings UI)',
  'PATCH /api/global-settings': 'machine-global settings (Settings UI)',
  'GET /api/instruction-templates': 'agent-prompt editor data (Settings UI)',
  'GET /api/harness-system-prompts': 'system-prompt editor data (Settings UI)',
  'GET /api/pi-models': 'Pi model dropdown data (Settings UI)',
  'POST /api/pi-endpoints/probe': 'Pi endpoint "Detect models" button (Settings UI)',
  'GET /api/mcp-catalog': 'MCP catalog (Settings UI)',
  'GET /api/mcp-secrets': 'MCP secret presence — never advertise to agents',
  'PATCH /api/mcp-secrets': 'MCP secret write — never advertise to agents',
  'GET /api/mcp-env-presence': 'MCP env detection (Settings UI)',
  'POST /api/mcp/validate': 'MCP key validation (Settings UI)',
  'GET /api/mcp-import/scan': 'MCP config import scan (Settings UI)',
  'POST /api/mcp-import': 'MCP config import apply (Settings UI)',

  // Reads that back the graph/editor. An agent has better native tools for
  // all of these (its own file read/grep/git), so pointing it at the HTTP
  // versions would be a downgrade.
  'GET /api/scan': 'source-tree scan powering the 3D graph',
  'GET /api/search': 'file-contents grep powering the graph search bar',
  'GET /api/git-history': 'timeline-scrubber history',
  'GET /api/git-branch': 'navbar branch label',
  'GET /api/tasks/worktree-modified': 'graph W-overlay data',
  'GET /api/list-dir': 'folder-picker listing',
  'POST /api/create-dir': 'folder-picker mkdir',

  // Liveness / debug / terminal plumbing.
  'GET /api/health': 'liveness probe',
  'GET /api/default-root': 'default project for the UI',
  'GET /api/harnesses': 'detected agent CLIs for the harness dropdowns',
  'GET /api/terminals': 'debug: list pty sessions',
  'POST /api/terminals': 'pty pre-spawn for the sidebar terminal',
  'DELETE /api/terminals/:id': 'debug: kill a pty session',
  'GET /api/spawn-queue': 'debug: spawn-queue snapshot',
};

// ---------------------------------------------------------------------- tests

test('every endpoint documented in the agent docs is a real route', () => {
  const rows = endpointTableRows(readTemplate());
  assert.ok(rows.length > 20, `endpoint table failed to parse (${rows.length} rows)`);

  const dead = rows
    .filter((r) => {
      const exact = `${r.method} ${r.path}`;
      return (
        !ROUTES.has(exact) &&
        !NORMALIZED_ROUTES.has(`${r.method} ${normalizePath(r.path)}`)
      );
    })
    .map((r) => `${r.method} ${r.path}`);

  assert.deepEqual(
    dead,
    [],
    'The agent doc templates document endpoints that no longer exist. Every ' +
      'project on every machine regenerates its .lattice/LATTICE_API*.md from ' +
      'them, so a dead row here is a lie shipped everywhere. Fix the row (or ' +
      'delete it) to match the router.',
  );
});

test('every curl/irm recipe in the agent docs hits a real route', () => {
  const paths = recipeUrlPaths(readTemplate());
  assert.ok(paths.length >= 6, `recipe URLs failed to parse (${paths.length} found)`);

  const dead = paths.filter(
    (p) => !ROUTE_PATHS.has(p) && !NORMALIZED_ROUTE_PATHS.has(normalizePath(p)),
  );

  assert.deepEqual(
    dead,
    [],
    'A copy-pasteable recipe in one of the agent doc templates targets a path ' +
      'the router does not serve — an agent following it verbatim gets a 404.',
  );
});

test('every route is either documented for agents or explicitly opted out', () => {
  const documented = new Set(
    endpointTableRows(readTemplate()).map(
      (r) => `${r.method} ${normalizePath(r.path)}`,
    ),
  );

  const unaccounted = [...ROUTES]
    .filter((route) => {
      const i = route.indexOf(' ');
      const normalized = `${route.slice(0, i)} ${normalizePath(route.slice(i + 1))}`;
      return !documented.has(normalized) && !(route in UNDOCUMENTED_ROUTES);
    })
    .sort();

  assert.deepEqual(
    unaccounted,
    [],
    'New route(s) with no decision recorded. Either add a row to the ' +
      '"Endpoint reference" table in LATTICE_API_RECIPES.template.md (if an ' +
      'agent driving the board should use it) or add an entry to ' +
      'UNDOCUMENTED_ROUTES in this test with the reason it stays hidden.',
  );
});

test('UNDOCUMENTED_ROUTES has no stale entries', () => {
  const stale = Object.keys(UNDOCUMENTED_ROUTES)
    .filter((route) => !ROUTES.has(route))
    .sort();

  assert.deepEqual(
    stale,
    [],
    'These routes were opted out of the agent docs but no longer exist. ' +
      'Drop them so the list keeps describing the real router.',
  );
});

test('the root CLAUDE.md HTTP table covers every route', () => {
  // The other half of the docs problem: CLAUDE.md's HTTP/WS table is what every
  // agent working ON Lattice reads. Unlike LATTICE_API.md it aims to be
  // exhaustive, so the contract here is total coverage in both directions.
  const md = fs.readFileSync(ROOT_CLAUDE_MD, 'utf8').replace(/\r\n?/g, '\n');
  const rows = new Set<string>();
  for (const m of md.matchAll(
    /^\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`([^`]+)`\s*\|/gm,
  )) {
    rows.add(`${m[1]} ${normalizePath(m[2].split('?')[0].replace(/\/$/, ''))}`);
  }
  assert.ok(rows.size > 50, `CLAUDE.md HTTP table failed to parse (${rows.size} rows)`);

  const missing = [...NORMALIZED_ROUTES].filter((r) => !rows.has(r)).sort();
  assert.deepEqual(missing, [], 'route(s) missing from the CLAUDE.md HTTP table');

  const dead = [...rows].filter((r) => !NORMALIZED_ROUTES.has(r)).sort();
  assert.deepEqual(dead, [], 'CLAUDE.md HTTP table lists route(s) that no longer exist');
});
