// `lattice-control` (the multi-instance controller: any project, any instance,
// workflow runs, a raw /api/ hatch) is opt-in AND reaches only sessions the user
// started — a sidebar or startup terminal, or the project-root reconcile. Even
// when it is switched on for every harness, a task agent, merge resolver,
// workflow step or QA/push run must not get it: those agents run on briefs
// nobody reviewed, and the controller would let one drive other boards and
// instances with one typed call (mcp/userLaunchedScope.ts, resolveEntries.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_MCP_SERVERS, LATTICE_CONTROL_MCP_SERVER_ID } from '../mcp/catalog.js';
import { resolveMcpEntries } from '../mcp/registry.js';
import { isUserLaunchedSpawn } from '../mcp/userLaunchedScope.js';
import { canonicalProjectPath } from '../projectPath.js';
import { resolveHarnessSpawnBody } from '../terminalServerClient/createSession.js';
import type { CreateSessionOptions } from '../terminalServerClient/spawnTypes.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run with the isolateHome preload');

const ID = LATTICE_CONTROL_MCP_SERVER_ID;
const CTX = { projectPath: 'c:\\dev\\proj', apiUrl: 'http://127.0.0.1:5184' };
const ON = {
  mcpOverrides: { [ID]: true },
  mcpHarnessOverrides: { codex: { [ID]: true }, pi: { [ID]: true } },
};
const ids = (entries: { entry: { id: string } }[]) => entries.map((e) => e.entry.id);

test('catalog: lattice-control is first-party, opt-in, and runs the lattice server in --controller mode', () => {
  const control = BUILTIN_MCP_SERVERS.find((s) => s.id === ID)!;
  const lattice = BUILTIN_MCP_SERVERS.find((s) => s.id === 'lattice')!;
  assert.equal(control.defaultEnabled, undefined);
  assert.equal(control.command, lattice.command);
  assert.deepEqual(control.args, [...lattice.args!, '--controller']);
  assert.deepEqual(control.harnessSupport, { claude: true, codex: true, pi: true });
});

test('resolver: off by default; on only with userLaunched, never in the lattice-only scope', () => {
  for (const h of ['claude', 'codex', 'pi'] as const) {
    assert.ok(!ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, {}, {}, h, { ...CTX, userLaunched: true })).includes(ID), h);
    assert.ok(!ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, ON, {}, h, CTX)).includes(ID), `${h}: not user-launched`);
    assert.ok(!ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, ON, {}, h, { ...CTX, userLaunched: true, latticeOnly: true })).includes(ID));
    assert.deepEqual(ids(resolveMcpEntries(BUILTIN_MCP_SERVERS, ON, {}, h, { ...CTX, userLaunched: true })), ['lattice', ID]);
  }
});

test('resolver: per-spawn env is the default instance + project, never a task id', () => {
  const catalog = BUILTIN_MCP_SERVERS.map((s) => (s.id === ID ? { ...s, env: { LATTICE_TASK_ID: 't_x', lattice_instances: 'x', KEEP: '1' } } : s));
  const [, control] = resolveMcpEntries(catalog, ON, {}, 'claude', { ...CTX, userLaunched: true, taskId: 't_abc' });
  assert.equal(control.entry.id, ID);
  assert.deepEqual(control.entry.env, {
    KEEP: '1',
    LATTICE_API_URL: CTX.apiUrl,
    LATTICE_PROJECT: canonicalProjectPath(CTX.projectPath),
  });
  // The shared catalog entry is never mutated.
  assert.equal(BUILTIN_MCP_SERVERS.find((s) => s.id === ID)!.env, undefined);
});

test('isUserLaunchedSpawn: explicit user/startup owner, no task markers, not a Lattice-managed cwd', () => {
  const root = path.resolve('some-project');
  const worktree = path.join(os.homedir(), '.lattice', 'worktrees', 'h', 'slug-1');
  const scratch = path.join(os.homedir(), '.lattice', 'per-project', 'h', 'workflow-runs', 'r', 'step-0');
  assert.equal(isUserLaunchedSpawn({ cwd: root, registry: { owner: 'user' } }), true);
  assert.equal(isUserLaunchedSpawn({ cwd: root, registry: { owner: 'startup' } }), true);
  for (const owner of ['task', 'merge', 'workflow-step', 'push', 'qa', 'post-merge', 'security-review'] as const) {
    assert.equal(isUserLaunchedSpawn({ cwd: root, registry: { owner } }), false, owner);
  }
  assert.equal(isUserLaunchedSpawn({ cwd: root }), false, 'no registry hint fails closed');
  assert.equal(isUserLaunchedSpawn({ cwd: root, registry: { owner: 'user' }, taskId: 't1' }), false);
  assert.equal(isUserLaunchedSpawn({ cwd: root, registry: { owner: 'user' }, mcpScope: 'task-worktree' }), false);
  assert.equal(isUserLaunchedSpawn({ cwd: root, registry: { owner: 'user' }, isQaRun: true }), false);
  assert.equal(isUserLaunchedSpawn({ cwd: worktree, registry: { owner: 'user' } }), false);
  assert.equal(isUserLaunchedSpawn({ cwd: scratch, registry: { owner: 'user' } }), false);
});

// ---- end to end through the spawn chokepoint ------------------------------------

// A temp project with lattice-control switched on for every harness.
function withProject(fn: (project: string) => Promise<void>): Promise<void> {
  return withTempDir('lattice-mcp-control-', async (dir) => {
    await writeLayout(dir, { '.lattice/userSettings.json': JSON.stringify(ON) });
    await fn(dir);
  });
}

async function homeDir(...parts: string[]): Promise<string> {
  const dir = path.join(os.homedir(), '.lattice', ...parts, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function claudeServers(opts: CreateSessionOptions): Promise<string[]> {
  const body = await resolveHarnessSpawnBody({ ...opts, initialCommand: 'claude "x"' });
  return Object.keys(body.managedMcpServers ?? {});
}

test('spawn chokepoint (claude): a sidebar tab gets lattice-control; task, resolver and step sessions never do', () => withProject(async (project) => {
  assert.deepEqual(await claudeServers({ cwd: project, projectPath: project, registry: { owner: 'user' } }), ['lattice', ID]);
  assert.deepEqual(await claudeServers({ cwd: project, projectPath: project, registry: { owner: 'startup' } }), ['lattice', ID]);

  // A project-root stash/snapshot resolver, and a spawn with no registry hint.
  assert.deepEqual(await claudeServers({ cwd: project, projectPath: project, registry: { owner: 'merge' } }), ['lattice']);
  assert.deepEqual(await claudeServers({ cwd: project, projectPath: project }), ['lattice']);
  // A task agent in its worktree (lattice-only scope) and a worktree resolver.
  const worktree = await homeDir('worktrees', 'abc123def456');
  for (const owner of ['task', 'merge'] as const) {
    assert.deepEqual(
      await claudeServers({ cwd: worktree, projectPath: project, taskId: 't1', mcpScope: 'task-worktree', registry: { owner } }),
      ['lattice'],
      owner,
    );
  }
  // A workflow step in its scratch dir.
  const stepDir = await homeDir('per-project', 'h', 'workflow-runs');
  assert.deepEqual(await claudeServers({ cwd: stepDir, projectPath: project, registry: { owner: 'workflow-step' } }), ['lattice']);
}));

test('spawn chokepoint (codex): the -c override for lattice-control rides only a user tab', () => withProject(async (project) => {
  const hasControl = async (opts: CreateSessionOptions) => {
    const body = await resolveHarnessSpawnBody({ ...opts, initialCommand: 'codex' });
    return (body.managedCodexConfigArgs ?? []).some((a) => a.startsWith('mcp_servers.lattice_lattice_control='));
  };
  assert.equal(await hasControl({ cwd: project, projectPath: project, registry: { owner: 'user' } }), true);
  const stepDir = await homeDir('per-project', 'h', 'workflow-runs');
  assert.equal(await hasControl({ cwd: stepDir, projectPath: project, registry: { owner: 'workflow-step' } }), false);
  const worktree = await homeDir('worktrees', 'abc123def456');
  assert.equal(
    await hasControl({ cwd: worktree, projectPath: project, taskId: 't1', mcpScope: 'task-worktree', registry: { owner: 'task' } }),
    false,
  );
}));
