// A true conversation resume bypasses the fresh command builder. Previously
// it launched the registry's stale model/permission flags while recording the
// newly resolved Pi model. Exercise the real resume builder -> harness factory
// override path, replacing only the worktree probe and PTY allocation.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTask, deleteTask, getTask, updateTask } from '../tasks.js';
import { patchUserSettings } from '../userSettings.js';
import { resumeTaskById, type ResumeTaskDeps } from '../routes/tasks/resumeTask.js';
import { selectHarnessCommand } from '../routes/tasks/harnessFactory.js';
import { parseAgentCommand } from '../terminalRegistry/commandParse.js';
import { agentSessionFromCommand, assignHarnessSessionId } from '../terminalRegistry/sessionIdentity.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { recordSpawnedTerminal } from '../terminalServerClient/recordSpawn.js';
import { withTempDir } from './helpers/tempDir.js';

async function fixture(
  t: TestContext,
  project: string,
  harness: 'pi' | 'codex',
  initialCommand: string,
  piModel?: string,
) {
  const session = { harness, id: harness === 'pi' ? 'lattice-conversation' : '019a-conversation' };
  const created = await createTask(project, 'resume launch policy');
  const task = (await updateTask(created.id, {
    status: 'in_progress', worktreePath: path.join(project, 'checkout'),
    branch: 'lattice/resume-policy', harness, piModel, agentSession: session,
  }))!;
  const original = await terminalRegistry.create({
    projectPath: project, cwd: task.worktreePath!, owner: 'task', taskId: task.id,
    label: 'original', launch: { initialCommand, harness, piModel },
    agentSession: { ...session, source: 'minted' }, serverId: 'old-pty',
  });
  t.after(async () => {
    await deleteTask(task.id);
    await terminalRegistry.endWhere((record) => record.projectPath === project, { reason: 'closed' });
  });

  let allocatedCommand: string | undefined;
  const deps: Partial<ResumeTaskDeps> = {
    worktreeExists: async () => true,
    selectHarnessCommand: (owner, options) => {
      assert.ok(options.commandOverride, 'must exercise a true resume, not the fresh builder');
      return selectHarnessCommand(owner, options, {
        proxyCreateSession: async (opts) => {
          const identity = assignHarnessSessionId(opts.initialCommand);
          allocatedCommand = identity.command;
          const record = await recordSpawnedTerminal(
            opts, opts.initialCommand, 'resumed-pty', 'executor', identity.agentSession,
          );
          assert.ok(record);
          return { id: 'resumed-pty', terminalId: record.id, agentSession: record.agentSession };
        },
      });
    },
    killSession: async () => { assert.fail('successful resume must not kill a PTY'); },
  };

  async function resume(requestedHarness?: string, requestedPiModel?: string) {
    const resumed = await resumeTaskById(task.id, requestedHarness, { deps }, requestedPiModel);
    assert.ok(resumed.terminalId);
    const record = await terminalRegistry.get(resumed.terminalId, project);
    assert.ok(record);
    assert.equal(resumed.command, allocatedCommand);
    assert.equal(record.launch.initialCommand, allocatedCommand);
    assert.equal(record.launch.harness, harness);
    assert.equal(record.launch.piModel, resumed.task.piModel);
    assert.equal(record.launch.mcpScope, 'task-worktree');
    assert.equal(record.taskId, task.id);
    assert.deepEqual(resumed.task.agentSession, session);
    assert.deepEqual((await getTask(task.id))?.agentSession, session);
    assert.deepEqual(agentSessionFromCommand(allocatedCommand), { ...session, source: 'command' });
    assert.deepEqual((await terminalRegistry.get(original.id, project))?.launch, original.launch);
    const parsed = parseAgentCommand(resumed.command, harness)!;
    assert.match(parsed.prompt?.value ?? '', /^Please continue this task\./);
    return { resumed, record, args: parsed.args.map((token) => token.value) };
  }
  return { task, session, resume };
}

for (const modelFlags of ['--model "provider/model-A"', '--model=provider/model-A --model "provider/model-A"', '']) {
  test(`Pi true resume applies the selected model (old flags: ${modelFlags || 'none'})`, async (t) => {
    await withTempDir('lattice-resume-model-', async (project) => {
      const f = await fixture(t, project, 'pi',
        `pi --approve ${modelFlags} --thinking high --append-system-prompt "Keep --model in this text" "original prompt"`,
        'provider/model-A');
      const model = 'my-vllm/meta-llama/model-B:high';
      const { resumed, record, args } = await f.resume('pi', model);
      assert.equal(resumed.task.piModel, model);
      assert.equal((await getTask(f.task.id))?.piModel, model);
      assert.equal(record.launch.piModel, model);
      assert.deepEqual(args, [
        '--approve', '--thinking', 'high', '--append-system-prompt', 'Keep --model in this text',
        '--session-id', f.session.id, '--model', model,
      ]);
    });
  });
}

test('body-less Pi conversation resume keeps the recorded model over the project default', async (t) => {
  await withTempDir('lattice-resume-recorded-model-', async (project) => {
    await patchUserSettings(project, { piModel: 'provider/project-default' });
    const f = await fixture(t, project, 'pi',
      'pi --approve --model "provider/model-A" "original prompt"', 'provider/model-A');
    const { resumed, record, args } = await f.resume();
    assert.equal(resumed.task.harness, 'pi');
    assert.equal(resumed.task.piModel, 'provider/model-A');
    assert.equal(record.launch.piModel, 'provider/model-A');
    assert.deepEqual(args, ['--approve', '--session-id', f.session.id, '--model', 'provider/model-A']);
  });
});

for (const codexYolo of [false, true]) {
  test(`Codex conversation resume changes --yolo from ${!codexYolo} to ${codexYolo}`, async (t) => {
    await withTempDir('lattice-resume-permissions-', async (project) => {
      const oldYolo = codexYolo ? '' : ' --yolo';
      const f = await fixture(t, project, 'codex',
        `codex${oldYolo} --model "codex-model" --config "note=keep --yolo text" --dangerously-bypass-hook-trust "original prompt"`);
      await patchUserSettings(project, { codexYolo });
      const { resumed, record, args } = await f.resume('codex');
      assert.equal(resumed.task.harness, 'codex');
      assert.equal(record.launch.piModel, undefined);
      assert.deepEqual(args, [
        'resume', f.session.id, '--model', 'codex-model', '--config', 'note=keep --yolo text',
        '--dangerously-bypass-hook-trust', ...(codexYolo ? ['--yolo'] : []),
      ]);
    });
  });
}

test('Codex resume also removes the long permission-bypass alias when disabled', async (t) => {
  await withTempDir('lattice-resume-permission-alias-', async (project) => {
    const f = await fixture(t, project, 'codex',
      'codex --dangerously-bypass-approvals-and-sandbox --yolo --dangerously-bypass-hook-trust "original prompt"');
    await patchUserSettings(project, { codexYolo: false });
    const { args } = await f.resume();
    assert.deepEqual(args, ['resume', f.session.id, '--dangerously-bypass-hook-trust']);
  });
});
