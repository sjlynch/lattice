import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTask, updateTask, deleteTask, flushPersist } from '../tasks.js';
import { subscribeTaskActivity, type TaskActivityEvent } from '../taskActivityEvents.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { scanRecentCodexRollouts } from '../terminalRegistry/codexRolloutScan.js';
import { codexSessionsDir } from '../terminalRegistry/harnessPaths.js';
import { canonicalProjectPath } from '../projectPath.js';
import { pollCodexTaskActivity, readCodexActivityLines, sameCodexActivitySession } from '../terminalRegistry/codexTaskActivity.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

// Regression: worktree Codex nodes had task colors but no file labels/beams
// when the hosted runner bypassed tool hooks. Polling is advisory, incremental,
// and limited to the exact live registry session and its worktree.
test('discovery reads metadata larger than 8 KB, including instruction text split across UTF-8 chunks', async () => {
  await withTempDir('lattice-codex-large-meta-', async (dir) => {
    const root = path.join(dir, 'sessions');
    const day = path.join(root, '2099', '01', '01');
    await fs.mkdir(day, { recursive: true });
    const at = Date.now();
    const file = path.join(day, 'rollout-large-thread.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: {
      id: 'large-thread', cwd: dir, timestamp: new Date(at).toISOString(),
      base_instructions: { text: 'café'.repeat(12_000) },
    } });
    await fs.writeFile(file, meta + '\n{}\n');
    const found = await scanRecentCodexRollouts(at - 1000, root);
    assert.equal(found.length, 1, 'a large first line still pins its session');
    assert.equal(found[0].id, 'large-thread');
    assert.equal(found[0].cwd, dir);
    assert.equal(found[0].file, file);
  });
});

test('the rollout reader preserves incomplete UTF-8 lines and reads each completed line once', async () => {
  await withTempDir('lattice-codex-activity-', async (dir) => {
    const file = path.join(dir, 'rollout.jsonl');
    const row = Buffer.from('{"file":"café.ts"}\n');
    const split = row.indexOf(Buffer.from('é')) + 1;
    await fs.writeFile(file, row.subarray(0, split));
    const incomplete = await readCodexActivityLines(file, 0);
    assert.deepEqual(incomplete, { lines: [], offset: 0 });
    await fs.appendFile(file, row.subarray(split));
    const complete = await readCodexActivityLines(file, incomplete.offset);
    assert.deepEqual(complete.lines, ['{"file":"café.ts"}']);
    assert.deepEqual(await readCodexActivityLines(file, complete.offset), { lines: [], offset: row.length });
    await fs.writeFile(file, '{}\n');
    assert.deepEqual(await readCodexActivityLines(file, complete.offset), { lines: ['{}'], offset: 3 });
  });
});

test('initial rollout reads are bounded and drop a partial first row', async () => {
  await withTempDir('lattice-codex-activity-tail-', async (dir) => {
    const file = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(file, 'x'.repeat(300 * 1024) + '\n{"new":true}\n');
    assert.deepEqual((await readCodexActivityLines(file, 0)).lines, ['{"new":true}']);
  });
});

test('replacing a PTY or conversation invalidates old activity even when the durable tab survives', () => {
  const record = { serverId: 'pty-1', serverInstanceId: 'instance-1',
    agentSession: { harness: 'codex' as const, id: 'thread-1', source: 'command' as const },
    restoredAt: 100 };
  assert.ok(sameCodexActivitySession(record, { ...record }));
  assert.ok(!sameCodexActivitySession(record, { ...record, serverId: 'pty-2' }));
  assert.ok(!sameCodexActivitySession(record, { ...record, serverInstanceId: 'instance-2' }));
  assert.ok(!sameCodexActivitySession(record, { ...record, restoredAt: 200 }));
  assert.ok(!sameCodexActivitySession(record, { ...record, agentSession: { ...record.agentSession, id: 'thread-2' } }));
});

test('hosted worktree reads and added files reach the task activity feed, once per transcript change', async (t) => {
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'requires the HOME-isolation preload');
  await withTempDir('lattice-codex-task-activity-', async (dir) => {
    const repo = path.join(dir, 'repo');
    const wt = path.join(dir, 'wt');
    await writeLayout(repo, { 'frontend/src/app.ts': '' });
    await writeLayout(wt, { 'frontend/src/app.ts': '' });
    const task = await createTask(repo, 'hosted activity');
    await updateTask(task.id, { status: 'in_progress', worktreePath: wt, harness: 'codex' });
    const sessionId = randomUUID();
    const day = path.join(codexSessionsDir(), '2099', '01', '01');
    await fs.mkdir(day, { recursive: true });
    const file = path.join(day, `rollout-fixture-${sessionId}.jsonl`);
    const record = await terminalRegistry.create({
      projectPath: repo, cwd: wt, owner: 'task', label: 'Codex', launch: { harness: 'codex' },
      taskId: task.id, serverId: 'activity-pty', serverInstanceId: 'activity-instance',
      agentSession: { harness: 'codex', id: sessionId, source: 'command' },
    });
    const live = { instanceId: 'activity-instance', serverIds: new Set(['activity-pty']) };
    const events: TaskActivityEvent[] = [];
    const unsubscribe = subscribeTaskActivity((event) => { if (event.taskId === task.id) events.push(event); });
    t.after(unsubscribe);
    const row = (payload: unknown, at = record.createdAt + 1) => JSON.stringify({
      timestamp: new Date(at).toISOString(), type: 'response_item', payload,
    }) + '\n';
    try {
      await fs.writeFile(file, row({ type: 'custom_tool_call', name: 'exec', call_id: 'read',
        input: 'await tools.exec_command({cmd: "Get-Content src/app.ts", workdir: "frontend"});' }));
      await pollCodexTaskActivity(live);
      assert.deepEqual(events.map((event) => event.file), [path.join(canonicalProjectPath(repo), 'frontend', 'src', 'app.ts')]);
      assert.equal(events[0].phase, 'start');
      await pollCodexTaskActivity(live);
      assert.equal(events.length, 1, 'an unchanged rollout is not replayed');

      const patch = '*** Begin Patch\n*** Add File: frontend/src/new.ts\n+new\n*** End Patch';
      await fs.appendFile(file, row({ type: 'custom_tool_call', name: 'exec', call_id: 'patch',
        input: `await tools.apply_patch(${JSON.stringify(patch)});` }));
      await pollCodexTaskActivity(live);
      assert.equal(events.length, 1, 'a new file does not exist at call time');
      await fs.writeFile(path.join(wt, 'frontend', 'src', 'new.ts'), 'new');
      await fs.appendFile(file, row({ type: 'custom_tool_call_output', call_id: 'patch', output: 'done' }));
      await pollCodexTaskActivity(live);
      assert.equal(events[1].file, path.join(canonicalProjectPath(repo), 'frontend', 'src', 'new.ts'));

      await terminalRegistry.update(record.id, { closePending: true }, repo);
      await fs.appendFile(file, row({ type: 'custom_tool_call', name: 'exec', call_id: 'late',
        input: 'await tools.exec_command({cmd: "cat frontend/src/app.ts"});' }));
      await pollCodexTaskActivity(live);
      assert.equal(events.length, 2, 'a closing task session emits no late activity');
    } finally {
      await terminalRegistry.end(record.id, { reason: 'owner-finished' }, repo);
      await deleteTask(task.id);
      await flushPersist(repo);
      await fs.rm(file, { force: true });
    }
  });
});
