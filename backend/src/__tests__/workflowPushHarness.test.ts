// Workflow Push ignored the run's harness/model override and always spawned
// Claude. Cover selection through the real scratch-session setup, callbacks,
// presence and persisted restart attachment without launching an agent or git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import type { Workflow, WorkflowStep } from '../workflows.js';
import {
  attachedPushSession, forgetPushRun, getPushRun, markPushRunDone,
  pushRunStore, startPushSession,
} from '../pushRuns.js';
import { deserializePushRun } from '../pushRuns/registry.js';
import { pushPaths } from '../pushRuns/paths.js';
import { pushAdapter } from '../recovery/oneOffRunResume/adapters.js';
import { listAgentSessions, unregisterAgentSession } from '../agentSessions.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { updateUserSettings } from '../userSettings.js';
import { withTempDir } from './helpers/tempDir.js';

const ORIGIN = 'http://127.0.0.1:5199';
const MODEL = 'local/meta-llama/Llama-3.1-8B-Instruct';

const selections: {
  name: string;
  step: Partial<WorkflowStep>;
  run?: Pick<WorkflowRun, 'harnessOverride' | 'piModelOverride'>;
  expectedHarness: 'claude' | 'codex' | 'pi';
  expectedModel?: string;
}[] = [
  { name: 'Codex override', step: { harness: 'claude' }, run: { harnessOverride: 'codex' }, expectedHarness: 'codex' },
  { name: 'Pi model override', step: { harness: 'claude' }, run: { harnessOverride: 'pi', piModelOverride: MODEL }, expectedHarness: 'pi', expectedModel: MODEL },
  { name: 'step Pi model', step: { harness: 'pi', piModel: MODEL }, expectedHarness: 'pi', expectedModel: MODEL },
  { name: 'Pi override without a model', step: { harness: 'pi', piModel: MODEL }, run: { harnessOverride: 'pi' }, expectedHarness: 'pi' },
  { name: 'Claude override clears step Pi model', step: { harness: 'pi', piModel: MODEL }, run: { harnessOverride: 'claude' }, expectedHarness: 'claude' },
  { name: 'step Codex selection', step: { harness: 'codex' }, expectedHarness: 'codex' },
  { name: 'legacy Claude default', step: {}, expectedHarness: 'claude' },
];

for (const selection of selections) {
  test(`Push forwards ${selection.name}`, async () => {
    const wf = { projectPath: '/project', steps: [{ kind: 'push', ...selection.step }] } as Workflow;
    const run: WorkflowRun = {
      id: 'wfrun_selection', workflowId: 'wf', workflowName: 'workflow',
      projectPath: wf.projectPath, status: 'running', startedAt: 1,
      currentStepIndex: 0, totalSteps: 1, ...selection.run,
    };
    let called = false;
    const deps: PushStepDeps = {
      waitForLaneEmpty: async () => undefined,
      subscribePushRuns: () => () => undefined,
      subscribeWorkflowRuns: () => () => undefined,
      proxyKillSession: async () => assert.fail('completed push must not be killed'),
      startPushSession: async (_project, _origin, opts) => {
        called = true;
        assert.equal(opts?.harness, selection.expectedHarness);
        assert.equal(opts?.piModel, selection.expectedModel);
        assert.equal(opts?.brief, 'workflow');
        assert.deepEqual(opts?.workflow, { runId: run.id, stepIndex: 0 });
        return { id: 'push_done', cwd: '/scratch', command: selection.expectedHarness };
      },
      getPushRun: () => ({ id: 'push_done', projectPath: wf.projectPath, cwd: '/scratch', status: 'done', createdAt: 1 }),
    };
    await runPushStep(wf, run, 0, ORIGIN, deps);
    assert.equal(called, true);
  });
}

for (const harness of ['claude', 'codex', 'pi'] as const) {
  test(`Push launches and recovers ${harness} with its completion plumbing`, async (t) => {
    await withTempDir('lattice-push-harness-', async (project) => {
      // Replace only the terminal allocation thunk. Setup, command construction,
      // admission, registration and persistence still execute their real paths.
      const addOrGet = queueState.addOrGet;
      t.mock.method(queueState, 'addOrGet', (args: Parameters<typeof addOrGet>[0]) => {
        assert.equal(args.kind, 'push-run');
        assert.equal(args.priority, 'interactive');
        return addOrGet.call(queueState, { ...args, thunk: async () => ({ id: 'test-push-pty' }) });
      });
      queueState.accounting.reconcile(0, Date.now() + 1);
      if (harness === 'codex') await updateUserSettings(project, () => ({ codexYolo: false }));
      const session = await startPushSession(project, ORIGIN, {
        brief: 'workflow', harness, piModel: MODEL,
        workflow: { runId: 'wfrun_actual', stepIndex: 2 },
      });
      try {
        assert.ok(session.command.startsWith(`${harness} `));
        assert.equal(session.command.includes(`--model "${MODEL}"`), harness === 'pi');
        if (harness === 'pi') assert.match(session.command, /--approve/);
        if (harness === 'codex') {
          assert.ok(!session.command.includes('--yolo'));
          assert.match(session.command, /--dangerously-bypass-hook-trust/);
        }
        const brief = await fs.readFile(path.join(session.cwd, 'PUSH_INSTRUCTIONS.md'), 'utf8');
        assert.match(brief, /Do not create\s+commits/);
        assert.equal(brief.includes(`${ORIGIN}/api/push-runs/${session.id}/done`), harness !== 'claude');
        if (harness !== 'claude') assert.match(brief, /last action/);
        for (const file of ['.claude/settings.local.json', '.codex/hooks.json', '.pi/extensions/lattice-complete.ts']) {
          const hook = await fs.readFile(path.join(session.cwd, file), 'utf8');
          assert.ok(hook.includes(`${ORIGIN}/api/push-runs/${session.id}/done`), file);
        }
        const piHook = await fs.readFile(path.join(session.cwd, '.pi/extensions/lattice-complete.ts'), 'utf8');
        assert.match(piHook, /const RESPECT_QUIT_GATE = true/);
        assert.match(await fs.readFile(path.join(session.cwd, '.pi/extensions/lattice-activity.ts'), 'utf8'), /agent-activity/);
        assert.equal(listAgentSessions(project).find((agent) => agent.agentId === `push:${session.id}`)?.harness, harness);
        await pushRunStore.flush(project);
        const [loaded] = await pushRunStore.load(project);
        assert.equal(loaded.harness, harness);
        assert.equal(loaded.piModel, harness === 'pi' ? MODEL : undefined);
        assert.equal(loaded.workflowRunId, 'wfrun_actual');
        assert.equal(attachedPushSession(loaded).command, session.command);
        unregisterAgentSession(`push:${session.id}`);
        pushAdapter.onReadopted(loaded);
        assert.equal(listAgentSessions(project).find((agent) => agent.agentId === `push:${session.id}`)?.harness, harness);
      } finally {
        unregisterAgentSession(`push:${session.id}`);
        markPushRunDone(session.id);
        forgetPushRun(session.id);
        await pushRunStore.flush(project);
        await fs.rm(pushPaths.assertSafeSessionPath(project, session.id), { recursive: true, force: true });
        queueState.accounting.reconcile(0, Date.now() + 1);
        queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
      }
    });
  });
}

test('push recovery defaults old records to Claude and rejects unsafe Pi models', () => {
  const project = path.resolve('push-deserialize-project');
  const id = pushPaths.createSessionId();
  const legacy = deserializePushRun({ id, status: 'running' }, project)!;
  assert.equal(legacy.harness, 'claude');
  assert.match(attachedPushSession(legacy).command, /^claude /);
  const unsafe = deserializePushRun({ id, status: 'running', harness: 'pi', piModel: 'local/model;whoami' }, project)!;
  assert.equal(unsafe.piModel, undefined);
  assert.match(attachedPushSession(unsafe).command, /^pi --approve /);
  assert.ok(!attachedPushSession(unsafe).command.includes('whoami'));
  assert.equal(getPushRun(id), undefined);
});
