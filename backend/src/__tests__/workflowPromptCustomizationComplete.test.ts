import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { completeWorkflowPromptCustomization } from '../workflowPromptCustomizations.js';
import {
  getWorkflowPromptCustomization,
  MAX_FINISHED_CUSTOMIZATIONS,
  storeWorkflowPromptCustomization,
} from '../workflowPromptCustomizations/registry.js';
import { preSpawnCustomizationSession } from '../workflowPromptCustomizations/sessionStarter.js';
import type { WorkflowPromptCustomization } from '../workflowPromptCustomizations/types.js';

// Regression guard for the "completed customization flipped to errored" bug.
//
// The Claude Stop hook always installs a backstop (lattice-customization-
// backstop.cjs) that re-POSTs /complete after the session exits. If the model
// already submitted a good prompt (status 'completed') but CUSTOMIZED_PROMPT.md
// is absent/unreadable at Stop time, the backstop POSTs {prompt:''}. Without a
// terminal-status guard, completeWorkflowPromptCustomization would overwrite the
// good record to status 'errored' and a polling frontend would discard a
// perfectly good customization. /complete must therefore be idempotent once the
// request reaches a terminal status.

function seedRunning(id: string): WorkflowPromptCustomization {
  const request: WorkflowPromptCustomization = {
    id,
    projectPath: 'C:/dev/proj',
    stepTitle: 'Some step',
    originalPrompt: 'original',
    harness: 'claude',
    status: 'running',
    createdAt: 1,
    command: 'claude',
    // Success path writes a best-effort audit copy to cwd — point it at a
    // real, writable dir so the write is harmless.
    cwd: os.tmpdir(),
  };
  storeWorkflowPromptCustomization(request);
  return request;
}

test('complete: a good prompt then an empty backstop POST keeps the completed result', async () => {
  const id = 'wpc_test_completed_keep';
  seedRunning(id);

  const first = await completeWorkflowPromptCustomization(id, 'a tailored prompt');
  assert.equal(first?.status, 'completed');
  assert.equal(first?.resultPrompt, 'a tailored prompt');

  // The Stop-hook backstop re-POSTs with an empty prompt (file gone at Stop
  // time). This must be a no-op — the good result is preserved.
  const second = await completeWorkflowPromptCustomization(id, '');
  assert.equal(second?.status, 'completed');
  assert.equal(second?.resultPrompt, 'a tailored prompt');
  assert.equal(second?.error, undefined);
});

test('complete: an empty first POST errors, and a later good POST does not resurrect it', async () => {
  const id = 'wpc_test_errored_sticky';
  seedRunning(id);

  // Backstop fires first (model never wrote the file) → errored.
  const first = await completeWorkflowPromptCustomization(id, '');
  assert.equal(first?.status, 'errored');
  assert.equal(first?.error, 'customized prompt was empty');

  // A late, good POST is ignored — terminal status is sticky.
  const second = await completeWorkflowPromptCustomization(id, 'too late');
  assert.equal(second?.status, 'errored');
  assert.equal(second?.resultPrompt, undefined);
});

test('complete: unknown id returns null', async () => {
  const result = await completeWorkflowPromptCustomization('wpc_never_seen', 'x');
  assert.equal(result, null);
});

// A non-CAP `{error}` from the queued spawn used to be only warned about; the
// record stayed `running` with no serverId and the frontend polled it for its
// whole budget.
test('pre-spawn {error} marks the request errored', async () => {
  const request = seedRunning('wpc_test_prespawn_error');
  await preSpawnCustomizationSession(request, {
    queuedCreateSession: async () => ({ error: 'terminal-server wedged' }),
  });
  assert.equal(request.status, 'errored');
  assert.equal(request.error, 'terminal-server wedged');
  assert.ok(typeof request.finishedAt === 'number');
  assert.equal(request.serverId, undefined);
  assert.equal(getWorkflowPromptCustomization(request.id)?.status, 'errored');
});

test('the registry prunes finished requests past MAX_FINISHED_CUSTOMIZATIONS and never a running one', () => {
  const stillRunning = seedRunning('wpc_prune_running');
  const ids: string[] = [];
  for (let i = 0; i < MAX_FINISHED_CUSTOMIZATIONS + 5; i++) {
    const done = seedRunning(`wpc_prune_${i}`);
    done.status = 'completed';
    done.finishedAt = 1_000 + i;
    ids.push(done.id);
    storeWorkflowPromptCustomization(done);
  }
  assert.equal(getWorkflowPromptCustomization(stillRunning.id)?.status, 'running');
  assert.equal(getWorkflowPromptCustomization(ids[0]), null, 'the oldest finished record is gone');
  assert.equal(getWorkflowPromptCustomization(ids[ids.length - 1])?.status, 'completed');
});
