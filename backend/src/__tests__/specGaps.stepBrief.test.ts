// Use the spawn caller's real project reads to feed the synchronous renderer;
// optional enrichment must fail open and respect user template overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readTaskWritingGuidance } from '../workflowRuns/stepSpawner.js';
import { renderStepMarkdown } from '../workflowRuns/stepMarkdown.js';
import { createTask, updateTask, flushPersist } from '../tasks.js';
import { patchUserSettings } from '../userSettings.js';
import type { Workflow } from '../workflows.js';
import type { WorkflowRun } from '../workflowRuns/types.js';
import { withTempDir } from './helpers/tempDir.js';

test('planning brief shows project rules then recent gaps in Writing each task; defaults and overrides', async () => {
  await withTempDir('lattice-gap-brief-', async (project) => {
    const wf: Workflow = { id: 'wf', name: 'Plan', projectPath: project, steps: [{ id: 's', title: 'Plan', prompt: 'File tasks', harness: 'claude', kind: 'agent' }], variables: [], createdAt: 1 };
    const run: WorkflowRun = { id: 'run', workflowId: wf.id, workflowName: wf.name, projectPath: project, status: 'running', startedAt: 1, totalSteps: 1, currentStepIndex: 0 };
    const render = (guidance: string, template?: string) => renderStepMarkdown(wf, run, 0, 'http://example.test', null, template, '', guidance);
    const empty = render(await readTaskWritingGuidance(project));
    assert.ok(!empty.includes('Rules for task descriptions'));
    assert.ok(!empty.includes('What implementers here'));
    assert.ok(!empty.includes('{{task_writing_guidance}}'));

    const task = await createTask(project, 'A timeout task');
    await updateTask(task.id, { summary: 'Spec gaps: Picked 30 seconds' });
    await flushPersist(project);
    await patchUserSettings(project, { taskWritingRules: ['Specify timeout values'] });
    const guidance = await readTaskWritingGuidance(project);
    const markdown = render(guidance);
    const endOfWriting = markdown.indexOf('algorithms to the implementer unless they matter.');
    const rulesAt = markdown.indexOf('**Rules for task descriptions');
    const gapsAt = markdown.indexOf('**What implementers here');
    assert.ok(endOfWriting > 0 && rulesAt > endOfWriting && gapsAt > rulesAt);
    assert.ok(markdown.indexOf('## Creating tasks') > gapsAt);
    assert.ok(markdown.includes('- Picked 30 seconds (task "A timeout task")'));
    assert.equal(render(guidance, 'Custom brief {{step_title}}'), 'Custom brief Plan');
    assert.equal(render(guidance, '{{task_writing_guidance}}'), guidance);

    await patchUserSettings(project, { plannerSpecGaps: false });
    const rulesOnly = await readTaskWritingGuidance(project);
    assert.ok(rulesOnly.includes('Specify timeout values'));
    assert.ok(!rulesOnly.includes('Picked 30 seconds'));
    await patchUserSettings(project, { taskWritingRules: [], plannerSpecGaps: true });
    assert.ok((await readTaskWritingGuidance(project)).includes('Picked 30 seconds'));
    await fs.writeFile(path.join(project, '.lattice', 'userSettings.json'), '{broken');
    assert.equal(await readTaskWritingGuidance(project), '', 'failed settings read suppresses all guidance');
  });
});
