// Task-worktree MCP scope (mcp/taskWorktreeScope.ts): task agents and worktree
// merge resolvers get only the Lattice MCP server when the project's
// `taskAgentsLatticeMcpOnly` setting is on (default), and ONLY when the cwd is a
// `~/.lattice/worktrees/` checkout. Plus the retired-built-in toggle stripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  codexUserServerDisableArgs,
  latticeOnlyMcpApplies,
  withClaudeStrictMcpFlags,
} from '../mcp/taskWorktreeScope.js';
import { resolveMcpEntries } from '../mcp/registry.js';
import { BUILTIN_MCP_SERVERS } from '../mcp/catalog.js';
import { resolveHarnessSpawnBody } from '../terminalServerClient/createSession.js';
import { getUserSettings, patchUserSettings } from '../userSettings.js';
import { EXPECTED_TERMINAL_FINGERPRINT } from '../terminalServerLifecycle.js';
import { recordAndSpawn } from '../mergeRuns/resolverSpawn/spawn.js';
import { handleResyncOutcome } from '../mergeRuns/resolverSpawn/handleOutcome.js';
import { respondResolverSession } from '../routes/tasks/mergeResponses.js';
import { selectHarnessCommand } from '../routes/tasks/harnessFactory.js';
import { createRunState, type MergeRun } from '../mergeRuns/state.js';
import type { Task } from '../tasks.js';
import type { MergeReadyTask } from '../routes/tasks/manualMergeTypes.js';
import { scanImportableServers } from '../mcp/importConfigs.js';
import { deserializeTerminalRecord } from '../terminalRegistry/store.js';

assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run with the isolateHome preload');

async function tempProject(settings: object = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mcp-scope-'));
  await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });
  await fs.writeFile(path.join(dir, '.lattice', 'userSettings.json'), JSON.stringify(settings));
  return dir;
}

async function tempWorktree(): Promise<string> {
  const dir = path.join(os.homedir(), '.lattice', 'worktrees', 'abc123def456', `task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ---- the decision ----------------------------------------------------------

test('latticeOnlyMcpApplies: scope + worktree cwd + setting absent/true → on', () => {
  const cwd = path.join(os.homedir(), '.lattice', 'worktrees', 'h', 'slug-1');
  assert.equal(latticeOnlyMcpApplies({ mcpScope: 'task-worktree', cwd }, {}), true);
  assert.equal(latticeOnlyMcpApplies({ mcpScope: 'task-worktree', cwd }, { taskAgentsLatticeMcpOnly: true }), true);
});

test('latticeOnlyMcpApplies: off when the setting is false, the scope is missing, or the cwd is not a home worktree', () => {
  const cwd = path.join(os.homedir(), '.lattice', 'worktrees', 'h', 'slug-1');
  assert.equal(latticeOnlyMcpApplies({ mcpScope: 'task-worktree', cwd }, { taskAgentsLatticeMcpOnly: false }), false);
  assert.equal(latticeOnlyMcpApplies({ cwd }, {}), false);
  // A project root (e.g. a stash resolver) must never get the restricted set.
  assert.equal(latticeOnlyMcpApplies({ mcpScope: 'task-worktree', cwd: path.resolve('some-project') }, {}), false);
  // The worktrees root itself and legacy in-repo worktrees don't qualify.
  assert.equal(latticeOnlyMcpApplies({ mcpScope: 'task-worktree', cwd: path.join(os.homedir(), '.lattice', 'worktrees') }, {}), false);
  assert.equal(latticeOnlyMcpApplies({ mcpScope: 'task-worktree', cwd: path.resolve('repo', '.lattice', 'worktrees', 'x') }, {}), false);
  assert.equal(latticeOnlyMcpApplies({ mcpScope: 'task-worktree' }, {}), false);
});

test('resolveMcpEntries latticeOnly: only the lattice server survives; lattice off → nothing', () => {
  const settings = { mcpOverrides: { playwright: true, blender: true }, mcpHarnessOverrides: { codex: { blender: true }, pi: { blender: true } } };
  const ctx = { projectPath: path.resolve('p'), apiUrl: 'http://127.0.0.1:1', latticeOnly: true };
  for (const harness of ['claude', 'codex', 'pi'] as const) {
    assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, settings, {}, harness, ctx).map((r) => r.entry.id), ['lattice'], harness);
  }
  const off = { mcpOverrides: { lattice: false, playwright: true } };
  assert.deepEqual(resolveMcpEntries(BUILTIN_MCP_SERVERS, off, {}, 'claude', ctx), []);
});

// ---- Claude flags ----------------------------------------------------------

test('withClaudeStrictMcpFlags: appends strict + the `=` form, quoted, forward slashes on win32', () => {
  const file = path.join(os.homedir(), '.lattice', 'per-project', 'h', 'mcp-config', 'claude-task-t1.json');
  const out = withClaudeStrictMcpFlags('claude --dangerously-skip-permissions "Read LATTICE_TASK.md" --session-id x', file);
  const expectedPath = process.platform === 'win32' ? file.replace(/\\/g, '/') : file;
  assert.equal(out, `claude --dangerously-skip-permissions "Read LATTICE_TASK.md" --session-id x --strict-mcp-config --mcp-config="${expectedPath}"`);
  assert.ok(!out!.includes('\\'));
});

test('withClaudeStrictMcpFlags: never stacks on existing MCP flags or an unquotable path', () => {
  assert.equal(withClaudeStrictMcpFlags('claude --strict-mcp-config "x"', '/a.json'), null);
  assert.equal(withClaudeStrictMcpFlags('claude --mcp-config=/b.json "x"', '/a.json'), null);
  assert.equal(withClaudeStrictMcpFlags('claude "x"', '/home/100%/a.json'), null);
  assert.equal(withClaudeStrictMcpFlags('claude "x"', '/home/$me/a.json'), null);
});

test('resolveHarnessSpawnBody (claude): worktree + scope → strict flags + lattice-only config + lattice-only reconcile', async () => {
  const project = await tempProject({ mcpOverrides: { playwright: true, blender: true } });
  const cwd = await tempWorktree();
  const body = await resolveHarnessSpawnBody({
    cwd, projectPath: project, taskId: 'task-abc', mcpScope: 'task-worktree',
    initialCommand: 'claude --dangerously-skip-permissions "Read LATTICE_TASK.md"',
  });
  assert.deepEqual(Object.keys(body.managedMcpServers ?? {}), ['lattice']);
  const m = /--strict-mcp-config --mcp-config="([^"]+)"$/.exec(body.initialCommand ?? '');
  assert.ok(m, body.initialCommand);
  const config = JSON.parse(await fs.readFile(m[1], 'utf8')) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  assert.deepEqual(Object.keys(config.mcpServers), ['lattice']);
  assert.equal(config.mcpServers.lattice.env?.LATTICE_TASK_ID, 'task-abc');
  // Durable home scratch, never the OS temp dir.
  assert.ok(path.resolve(m[1]).toLowerCase().startsWith(path.join(os.homedir(), '.lattice', 'per-project').toLowerCase()));
});

test('resolveHarnessSpawnBody (claude): lattice switched off → strict with an EMPTY config', async () => {
  const project = await tempProject({ mcpOverrides: { lattice: false, playwright: true } });
  const cwd = await tempWorktree();
  const body = await resolveHarnessSpawnBody({
    cwd, projectPath: project, taskId: 't2', mcpScope: 'task-worktree', initialCommand: 'claude "x"',
  });
  assert.deepEqual(body.managedMcpServers, {});
  const m = /--mcp-config="([^"]+)"$/.exec(body.initialCommand ?? '');
  assert.ok(m, body.initialCommand);
  assert.deepEqual(JSON.parse(await fs.readFile(m[1], 'utf8')), { mcpServers: {} });
});

test('resolveHarnessSpawnBody (claude): no flags at a project root, without the scope, or with the setting off', async () => {
  const project = await tempProject({ mcpOverrides: { playwright: true } });
  const cwd = await tempWorktree();
  const cases = [
    { cwd: project, mcpScope: 'task-worktree' as const, projectPath: project },
    { cwd, projectPath: project },
    { cwd, mcpScope: 'task-worktree' as const, projectPath: await tempProject({ mcpOverrides: { playwright: true }, taskAgentsLatticeMcpOnly: false }) },
  ];
  for (const c of cases) {
    const body = await resolveHarnessSpawnBody({ ...c, initialCommand: 'claude "x"' });
    assert.equal(body.initialCommand, 'claude "x"');
    assert.deepEqual(Object.keys(body.managedMcpServers ?? {}).sort(), ['lattice', 'playwright']);
  }
});

// ---- Codex -----------------------------------------------------------------

test('codexUserServerDisableArgs: disables the user config servers by name, skips managed + unsafe names', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-codex-home-'));
  const cwd = await tempWorktree();
  await fs.writeFile(path.join(home, 'config.toml'), [
    'model = "x"',
    '[mcp_servers.userserver]', 'command = "npx"',
    '[mcp_servers.lattice_lattice]', 'command = "node"',
    '[mcp_servers."has space"]', 'command = "x"',
  ].join('\n'));
  await fs.mkdir(path.join(cwd, '.codex'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.codex', 'config.toml'), '[mcp_servers.repo-server]\nurl = "http://x"\n');
  const args = await codexUserServerDisableArgs(cwd, new Set(['lattice_lattice']), { CODEX_HOME: home });
  assert.deepEqual(args, ['mcp_servers.repo-server.enabled=false', 'mcp_servers.userserver.enabled=false']);
  // No config files → nothing to disable.
  assert.deepEqual(await codexUserServerDisableArgs(await tempWorktree(), new Set(), { CODEX_HOME: path.join(home, 'missing') }), []);
});

test('resolveHarnessSpawnBody (codex): user-server disables come BEFORE the lattice override, nothing else', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-codex-home-'));
  await fs.writeFile(path.join(home, 'config.toml'), '[mcp_servers.userserver]\ncommand = "npx"\n');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const project = await tempProject({ mcpHarnessOverrides: { codex: { playwright: true } } });
    const cwd = await tempWorktree();
    const scoped = await resolveHarnessSpawnBody({ cwd, projectPath: project, taskId: 't', mcpScope: 'task-worktree', initialCommand: 'codex "x"' });
    const args = scoped.managedCodexConfigArgs ?? [];
    assert.equal(args[0], 'mcp_servers.userserver.enabled=false');
    assert.equal(args.length, 2);
    assert.match(args[1], /^mcp_servers\.lattice_lattice=/);
    // Unscoped: no disables, the project's full set.
    const plain = await resolveHarnessSpawnBody({ cwd, projectPath: project, initialCommand: 'codex "x"' });
    const keys = (plain.managedCodexConfigArgs ?? []).map((a) => a.split('=')[0]).sort();
    assert.deepEqual(keys, ['mcp_servers.lattice_lattice', 'mcp_servers.lattice_playwright']);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

// ---- Pi --------------------------------------------------------------------

test('resolveHarnessSpawnBody (pi): scoped .pi/mcp.json carries only the lattice server', async () => {
  const project = await tempProject({ mcpHarnessOverrides: { pi: { playwright: true, blender: true } } });
  const cwd = await tempWorktree();
  await resolveHarnessSpawnBody({ cwd, projectPath: project, taskId: 't', mcpScope: 'task-worktree', initialCommand: 'pi --approve "x"' });
  const doc = JSON.parse(await fs.readFile(path.join(cwd, '.pi', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(doc.mcpServers), ['lattice']);
  // The same cwd unscoped picks the full set back up (reconcile, not append).
  await resolveHarnessSpawnBody({ cwd, projectPath: project, initialCommand: 'pi --approve "x"' });
  const full = JSON.parse(await fs.readFile(path.join(cwd, '.pi', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(full.mcpServers).sort(), ['blender', 'lattice', 'playwright']);
});

// ---- retired built-ins: stale toggles are stripped ---------------------------

test('userSettings: retired built-in ids are stripped from both toggle maps on read and on patch', async () => {
  const project = await tempProject({
    mcpOverrides: { context7: true, 'chrome-devtools': true, playwright: true },
    mcpHarnessOverrides: { codex: { context7: true, blender: true }, pi: { 'chrome-devtools': true } },
  });
  const read = await getUserSettings(project);
  assert.deepEqual(read.mcpOverrides, { playwright: true });
  assert.deepEqual(read.mcpHarnessOverrides, { codex: { blender: true }, pi: {} });
  const patched = await patchUserSettings(project, { mcpOverrides: { context7: true, blender: false } });
  assert.deepEqual(patched.mcpOverrides, { blender: false });
  const onDisk = JSON.parse(await fs.readFile(path.join(project, '.lattice', 'userSettings.json'), 'utf8'));
  assert.deepEqual(onDisk.mcpHarnessOverrides, { codex: { blender: true }, pi: {} });
});

// ---- spawn sites pass taskId + scope -----------------------------------------

type Captured = Record<string, unknown>;

// A fake terminal-server: healthy, records every POST /sessions body.
async function withFakeTerminalServer<T>(fn: (bodies: Captured[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const bodies: Captured[] = [];
  let n = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return Response.json({ ok: true, fingerprint: EXPECTED_TERMINAL_FINGERPRINT });
    }
    if (url.endsWith('/sessions') && init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)) as Captured);
      return Response.json({ id: `pty-${++n}` });
    }
    return Response.json([]);
  }) as typeof fetch;
  try {
    return await fn(bodies);
  } finally {
    globalThis.fetch = original;
  }
}

function mergeFixture(projectPath: string, worktreePath: string) {
  const task = { id: 'task-scope', projectPath, worktreePath, branch: 'lattice/t', title: 'scope task', createdAt: 1, status: 'ready_to_merge' } as Task;
  const run: MergeRun = { id: `run-${Math.random()}`, projectPath, status: 'running', startedAt: 1, total: 1, processed: 0, merged: [], conflicted: [], errored: [], cancelRequested: false };
  const state = createRunState();
  state.emit = () => {};
  return { task, run, ctx: { state, projectPath, backendOrigin: 'http://unused', baselineHead: null } };
}

test('handleResyncOutcome: only the merge-conflict (worktree) resolver is marked inWorktree', async () => {
  const project = await tempProject();
  const f = mergeFixture(project, await tempWorktree());
  const seen: Array<boolean | undefined> = [];
  const deps = {
    recordAndSpawn: async (input: Parameters<typeof recordAndSpawn>[0]) => {
      seen.push(input.inWorktree);
      return { kind: 'spawn-error' as const, error: 'stop here' };
    },
    parkOnConflictResolver: async () => 'signalled' as const,
  };
  await handleResyncOutcome(f.task, f.run, f.ctx, { kind: 'stash-conflict', cwd: project, resolveCommand: 'claude "stash"', conflictedFiles: [] } as never, undefined, deps as never);
  await handleResyncOutcome(f.task, f.run, f.ctx, { kind: 'merge-conflict', cwd: f.task.worktreePath!, command: 'claude "merge"', conflictedFiles: [] } as never, undefined, deps as never);
  assert.deepEqual(seen, [undefined, true]);
});

test('merge-run resolver spawn: a worktree resolver carries taskId + scope; a stash resolver neither', async () => {
  const project = await tempProject();
  const worktree = await tempWorktree();
  await withFakeTerminalServer(async (bodies) => {
    const f = mergeFixture(project, worktree);
    await recordAndSpawn({ task: f.task, run: f.run, runCtx: f.ctx, cwd: worktree, command: 'claude "Please read MERGE_INSTRUCTIONS.md"', conflictedFiles: [], inWorktree: true });
    const g = mergeFixture(project, worktree);
    await recordAndSpawn({ task: g.task, run: g.run, runCtx: g.ctx, cwd: project, command: 'claude "stash"', conflictedFiles: [] });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].taskId, 'task-scope');
    assert.equal(bodies[0].mcpScope, 'task-worktree');
    assert.match(String(bodies[0].initialCommand), /--strict-mcp-config --mcp-config="/);
    assert.equal(bodies[1].taskId, undefined);
    assert.equal(bodies[1].mcpScope, undefined);
    assert.doesNotMatch(String(bodies[1].initialCommand), /strict-mcp-config/);
  });
});

test('manual merge resolver: worktree conflict carries taskId + scope; stash conflict neither', async () => {
  const project = await tempProject();
  const worktree = await tempWorktree();
  const res = { json: (b: unknown) => b, status() { return this; } };
  const task = { id: 'task-manual', projectPath: project, worktreePath: worktree, branch: 'lattice/m', title: 'manual', createdAt: 1, status: 'ready_to_merge' } as unknown as MergeReadyTask;
  await withFakeTerminalServer(async (bodies) => {
    await respondResolverSession(res as never, task, { command: 'claude "merge"', cwd: worktree, conflictedFiles: ['a.ts'] });
    await respondResolverSession(res as never, task, { stashConflict: true, command: 'claude "stash"', cwd: project, conflictedFiles: ['a.ts'] });
    assert.equal(bodies[0].taskId, 'task-manual');
    assert.equal(bodies[0].mcpScope, 'task-worktree');
    assert.equal(bodies[1].taskId, undefined);
    assert.equal(bodies[1].mcpScope, undefined);
  });
});

test('task run/resume spawn carries taskId + the task-worktree scope', async () => {
  const project = await tempProject();
  const worktree = await tempWorktree();
  const task = { id: 'task-run', projectPath: project, title: 'run me', createdAt: 1, status: 'open' } as Task;
  await withFakeTerminalServer(async (bodies) => {
    for (const mode of ['run', 'resume'] as const) {
      const sel = selectHarnessCommand(task, { requestedHarness: 'claude', mode });
      await sel.createSession({ taskFile: 'LATTICE_TASK.md', cwd: worktree });
    }
    assert.equal(bodies.length, 2);
    for (const b of bodies) {
      assert.equal(b.taskId, 'task-run');
      assert.equal(b.mcpScope, 'task-worktree');
      assert.match(String(b.initialCommand), /--strict-mcp-config --mcp-config="/);
    }
  });
});

test('import: a server named like a retired built-in is renamed so its toggles still work', async () => {
  const claudeJson = path.join(os.homedir(), '.claude.json');
  const prev = await fs.readFile(claudeJson, 'utf8').catch(() => null);
  await fs.writeFile(claudeJson, JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } }));
  try {
    const { servers } = await scanImportableServers();
    const ids = servers.map((s) => s.id);
    assert.ok(ids.includes('context7-imported'), ids.join(','));
    assert.ok(!ids.includes('context7'));
  } finally {
    if (prev === null) await fs.rm(claudeJson, { force: true }); else await fs.writeFile(claudeJson, prev);
  }
});

test('terminal registry: the MCP scope survives a round trip, anything else is dropped', () => {
  const base = { id: 't1', projectPath: 'p', cwd: 'c', owner: 'task', label: 'x' };
  const kept = deserializeTerminalRecord({ ...base, launch: { initialCommand: 'claude', mcpScope: 'task-worktree' } });
  assert.equal(kept?.launch.mcpScope, 'task-worktree');
  const dropped = deserializeTerminalRecord({ ...base, launch: { initialCommand: 'claude', mcpScope: 'bogus' } });
  assert.equal(dropped?.launch.mcpScope, undefined);
});
