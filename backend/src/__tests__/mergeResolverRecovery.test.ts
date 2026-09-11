import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { respawnResolverForFlaggedConflict } from '../mergeRuns/resolverSpawn/spawn.js';
import { createRunState, type MergeRun, type MergeRunEvent } from '../mergeRuns/state.js';
import type { Task } from '../tasks.js';

function fixture() {
  const projectPath = path.resolve('isolated-project');
  const worktreePath = path.resolve('isolated-worktree');
  const task = { id: 'task-recovery', projectPath, worktreePath, branch: 'lattice/task', conflict: true, title: 'task', createdAt: 1, status: 'ready_to_merge' } as Task;
  const run: MergeRun = { id: 'run-recovery', projectPath, status: 'running', startedAt: 1, total: 1, processed: 0, merged: [], conflicted: [], errored: [], cancelRequested: false };
  const state = createRunState();
  const events: MergeRunEvent[] = [];
  state.subscribe((event) => events.push(event));
  // Avoid persistence in this unit test; notification still exercises the
  // subscriber-facing payload through the manager's public facade.
  state.emit = (event) => { events.push(event); };
  let spawns = 0;
  const deps: NonNullable<Parameters<typeof respawnResolverForFlaggedConflict>[3]> = {
    listSessions: async () => [],
    listConflictedFiles: async () => ['work.ts'],
    prepareMergeConflictOutcome: async () => ({ conflictedFiles: ['work.ts'], relativePath: 'MERGE_INSTRUCTIONS.md', command: 'claude resolver', cwd: worktreePath }),
    spawnAndRecord: async () => { spawns += 1; return { kind: 'spawned', serverId: 'new-pty' }; },
  };
  return { task, run, ctx: { state, projectPath, backendOrigin: 'http://unused', baselineHead: null }, deps, events, spawns: () => spawns };
}

test('merge recovery reattaches the detached resolver that survived the backend', async () => {
  const f = fixture();
  f.deps.listSessions = async () => [{ id: 'surviving-pty', cwd: f.task.worktreePath, initialCommand: 'claude --dangerously-skip-permissions "Please read MERGE_INSTRUCTIONS.md and resolve the merge conflicts."' }];
  assert.deepEqual(await respawnResolverForFlaggedConflict(f.task, f.run, f.ctx, f.deps), { kind: 'spawned', serverId: 'surviving-pty' });
  assert.equal(f.spawns(), 0, 'a restart must not create two agents writing the same merge index');
  assert.equal(f.events[0].type, 'conflict');
  assert.equal('serverId' in f.events[0] && f.events[0].serverId, 'surviving-pty');
});

test('merge recovery does not treat an unreachable terminal server as proof the resolver died', async () => {
  const f = fixture();
  f.deps.listSessions = async () => null;
  assert.equal((await respawnResolverForFlaggedConflict(f.task, f.run, f.ctx, f.deps)).kind, 'spawn-error');
  assert.equal(f.spawns(), 0);
});

test('merge recovery spawns a resolver when only an unrelated shell is present', async () => {
  const f = fixture();
  f.deps.listSessions = async () => [{ id: 'shell', cwd: f.task.worktreePath, initialCommand: 'cmd.exe' }];
  assert.equal((await respawnResolverForFlaggedConflict(f.task, f.run, f.ctx, f.deps)).kind, 'spawned');
  assert.equal(f.spawns(), 1);
});

test('merge recovery never adopts the original task agent as its resolver', async () => {
  const f = fixture();
  f.deps.listSessions = async () => [{ id: 'task-agent', cwd: f.task.worktreePath, initialCommand: 'claude --dangerously-skip-permissions "Please read LATTICE_TASK.md"' }];
  assert.equal((await respawnResolverForFlaggedConflict(f.task, f.run, f.ctx, f.deps)).kind, 'spawned');
  assert.equal(f.spawns(), 1);
});
