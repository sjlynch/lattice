// Run tests step and workflow Push briefs: the recently-merged-tasks block
// (qa/done since the window, newest first, capped, 3 description lines); the
// Run tests brief renders every token for each harness, Pi/Codex getting the
// explicit completion curl; Claude's --add-dir=<project> goes before the
// prompt (the variadic flag must not swallow it); the workflow Push brief
// pushes only while the QA-lane Push brief is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../tasks.js';
import { renderRunTestsBrief } from '../workflowRuns/testStep/brief.js';
import { renderRecentTasksBlock, selectRecentlyMergedTasks } from '../workflowRuns/testStep/recentTasks.js';
import { buildWorkflowStepCommand } from '../workflowRuns/commandBuilder.js';
import { renderPushInstructions } from '../pushRuns/instructions.js';
import {
  DEFAULT_PUSH_TEMPLATE,
  DEFAULT_WORKFLOW_PUSH_TEMPLATE,
  getInstructionTemplateDef,
} from '../instructionTemplates/defs.js';

test('recent merged tasks: qa/done since the window, newest first, capped, 3 description lines', () => {
  const t = (i: number, status: Task['status'], mergedAt: number): Task => ({
    id: `t${i}`, projectPath: '/p', title: `Task ${i}`, status, createdAt: 0, mergedAt,
    description: `\nline one\n\nline two\nline three\nline four`,
  });
  const tasks = [t(1, 'qa', 100), t(2, 'done', 300), t(3, 'open', 400), t(4, 'qa', 50), ...Array.from({ length: 40 }, (_, i) => t(10 + i, 'done', 1000 + i))];
  const picked = selectRecentlyMergedTasks(tasks, 100);
  assert.equal(picked.length, 30);
  assert.equal(picked[0].id, 't49');
  assert.ok(!picked.some((x) => x.id === 't3' || x.id === 't4'));
  const block = renderRecentTasksBlock(picked.slice(0, 1), 'since x');
  assert.match(block, /\*\*Task 49\*\* \(done\)\n  > line one\n  > line two\n  > line three$/);
  assert.match(renderRecentTasksBlock([], 'since x'), /No tasks reached QA or Done since x/);
});

test('Run tests brief renders every token for each harness; Pi/Codex get the explicit completion', () => {
  for (const harness of ['claude', 'pi', 'codex'] as const) {
    const md = renderRunTestsBrief({
      harness, projectPath: 'C:\\proj', stepDir: 'C:\\proj\\.lattice\\workflow-steps\\r\\step-0', stepIndex: 2, totalSteps: 4,
      completeUrl: 'http://x/api/workflow-runs/r/steps/2/complete', timeoutMinutes: 60, userWipFile: 'C:\\w\\USER_WIP.txt',
      userWipCount: 3, recentTasksBlock: '- **T**',
    });
    assert.doesNotMatch(md, /\{\{\s*\w+\s*\}\}/, `${harness}: no leftover tokens`);
    assert.match(md, /cd "C:\\proj"/);
    assert.match(md, /step 3 of 4/);
    assert.match(md, /git commit -m "<what you fixed and why>" -- <path>/);
    assert.match(md, /Never\*\* run `git add -A`/);
    assert.match(md, /3 path\(s\)/);
    assert.match(md, /TEST_SUMMARY\.md/);
    if (harness === 'claude') assert.doesNotMatch(md, /curl/);
    else assert.match(md, /curl -s -m 20 --retry 15 --retry-delay 3 --retry-connrefused -X POST "http:\/\/x\/api\/workflow-runs\/r\/steps\/2\/complete\?source=model-explicit-curl"/);
  }
  assert.ok(getInstructionTemplateDef('run-tests'), 'registered in the Agent prompts catalog');
});

test('Claude gets --add-dir=<project> before the prompt (the variadic flag must not swallow it)', () => {
  const cmd = buildWorkflowStepCommand('/x/RUN_TESTS.md', 'claude', undefined, undefined, { claudeAddDir: '/proj dir' });
  assert.match(cmd, /^claude --dangerously-skip-permissions --add-dir="\/proj dir" "Please read RUN_TESTS\.md/);
  assert.doesNotMatch(buildWorkflowStepCommand('/x/RUN_TESTS.md', 'codex', undefined, undefined, { claudeAddDir: '/p' }), /add-dir/);
});

test('the workflow Push brief pushes only; the QA-lane Push brief is unchanged', () => {
  const wfPush = renderPushInstructions('C:\\proj', DEFAULT_WORKFLOW_PUSH_TEMPLATE);
  assert.doesNotMatch(wfPush, /git add -A|git add \.|git commit -m/);
  assert.match(wfPush, /git push -u origin HEAD/);
  assert.match(wfPush, /cd "C:\\proj"/);
  const qaPush = renderPushInstructions('C:\\proj', DEFAULT_PUSH_TEMPLATE);
  assert.match(qaPush, /git add -A/);
  assert.match(qaPush, /git commit -m/);
  assert.equal(getInstructionTemplateDef('workflow-push')?.filename, 'PUSH_INSTRUCTIONS.md');
});
