// Shared harness for the split workflowRunTestsStep.* suites (dispatch,
// cleanup, resume). Not a `*.test.ts` file, so it isn't collected as a suite.
//
// `setup()` swaps the Run tests step's git / state / spawn seams
// (`setRunTestsDepsForTest`) for recording fakes over a fresh temp project; its
// `cleanup()` aborts every run left in such a project, restores the real deps
// and removes the dir. `startTestRun()` creates and starts a workflow through
// the real engine.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWorkflowRun } from '../../workflowRuns.js';
import { runs, type WorkflowRun } from '../../workflowRuns/state.js';
import { createWorkflow, type WorkflowStep } from '../../workflows.js';
import { abortRunTestsStep, setRunTestsDepsForTest, type RunTestsDeps } from '../../workflowRuns/testStep/runTestsStep.js';

export const ORIGIN = 'http://127.0.0.1:5184';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

export function testStep(over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: `t${Math.random().toString(36).slice(2, 7)}`, title: 'Run tests', prompt: '', harness: 'claude', kind: 'test', ...over };
}

type Harness = {
  project: string;
  calls: { spawn: Array<Parameters<RunTestsDeps['spawnStep']>>; kill: number; writeState: Array<{ lastHead: string }> };
  restore: () => void;
  cleanup: () => Promise<void>;
};

export async function setup(overrides: Partial<RunTestsDeps> = {}): Promise<Harness> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-runtests-'));
  const calls: Harness['calls'] = { spawn: [], kill: 0, writeState: [] };
  const restore = setRunTestsDepsForTest({
    readHead: async () => 'aaaaaaa1',
    isDetached: async () => false,
    readStatus: async () => [],
    readCommitsSince: async () => [],
    readState: async () => null,
    writeState: async (_p, s) => { calls.writeState.push(s); },
    listTasks: async () => [],
    spawnStep: async (...args) => { calls.spawn.push(args); return { command: 'claude', cwd: '' }; },
    killStepSession: async () => { calls.kill += 1; },
    ...overrides,
  });
  return {
    project,
    calls,
    restore,
    cleanup: async () => {
      try {
        for (const [id, r] of [...runs.entries()]) if (r.projectPath.toLowerCase().includes('lattice-runtests-')) {
          await abortRunTestsStep(id);
          runs.delete(id);
        }
      } finally {
        restore();
        await sleep(150); // let the workflow store flush
        await fs.rm(project, { recursive: true, force: true });
      }
    },
  };
}

export async function startTestRun(project: string, steps: WorkflowStep[]): Promise<WorkflowRun> {
  const wf = await createWorkflow(project, 'Run tests wf', steps);
  const started = await startWorkflowRun(wf.id, ORIGIN);
  return runs.get(started.id)!;
}
