import { withTempDir } from './helpers/tempDir.js';
import { resumePersistedRun } from '../recovery/workflowRunResume.js';
import { runs } from '../workflowRuns/state.js';
import { flushWorkflowRunPersist, writeWorkflowRunsNow } from '../workflowRuns/persistence.js';
import { canonicalProjectPath } from '../projectPath.js';
// Splits expand only into the frozen run definition, preserving ordinary engine behavior.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandWorkflowSplits } from '../workflowRuns/split.js';
import { normalizeSteps } from '../workflows/normalization.js';
import { nextStepGroup, openStepGroup } from '../workflowRuns/execution.js';
import { deserializeWorkflowRun, serializeWorkflowRuns } from '../workflowRuns/runCodec.js';
import { interpolateWorkflowVariables } from '../workflows/interpolate.js';
import type { Workflow, WorkflowStep } from '../workflows/types.js';
import type { WorkflowRun } from '../workflowRuns/types.js';
const source = { files: Array.from({ length: 20 }, (_, i) => ({ path: `${i < 10 ? 'a' : 'b'}/f${i}.ts`, weight: 5 })), packageRoots: ['.'] };
const parent: WorkflowStep = { id: 'parent', title: 'Review', prompt: 'Find {{topic}}', harness: 'pi', piModel: 'provider/model', model: 'custom', effort: 'high', tools: ['opengrep'], split: { mode: 'auto', count: 2 } };
const wf = (steps: WorkflowStep[]): Workflow => ({ id: 'wf', name: 'Workflow', projectPath: process.cwd(), createdAt: 1, variables: [{ id: 'v', name: 'topic', value: 'bugs' }], steps });
test('normalization validates split paths, clamps count and strips non-agent config', () => {
  const normalized = normalizeSteps([{ ...parent, split: { mode: 'auto', count: 99 } }, { ...parent, split: { mode: 'auto' } },
    { ...parent, split: { mode: 'custom', areas: [{ label: ' x ', paths: ['src', 'a.ts', 'src/*', '.', './*', '../x', 'a/../b', '/abs', 'C:/src', 'C:rel', 'a\\b', 'a/**'] }, { label: 'empty', paths: [] }, { label: 'a'.repeat(100), paths: ['lib'] }] } },
    ...['start', 'merge', 'push', 'test'].map((kind) => ({ ...parent, kind }))]);
  assert.equal(normalized[0].split?.count, 16); assert.equal(normalized[1].split?.count, 10);
  assert.deepEqual(normalized[2].split?.areas?.[0], { label: 'x', paths: ['src', 'a.ts', 'src/*', '.', './*'] });
  assert.equal(normalized[2].split?.areas?.length, 2); assert.equal(normalized[2].split?.areas?.[1].label.length, 80);
  assert.ok(normalized.slice(3).every((s) => s.split === undefined));
});
test('member fields, exact scope separator, interpolation and immutable authored definition', async () => {
  const before = structuredClone(parent);
  const { definition, notes } = await expandWorkflowSplits(wf([parent]), async () => source);
  assert.deepEqual(parent, before); assert.deepEqual(notes, []); assert.equal(definition.steps.length, 2);
  definition.steps.forEach((s, i) => {
    assert.equal(s.id, `parent__area${i + 1}`); assert.equal(s.split, undefined); assert.equal(s.splitOf, 'parent');
    assert.equal(s.title, `Review \u00b7 ${s.splitArea!.label}`);
    assert.equal(s.harness, 'pi'); assert.equal(s.piModel, parent.piModel); assert.equal(s.effort, 'high'); assert.equal(s.model, 'custom');
    assert.deepEqual(s.tools, ['opengrep']); assert.equal(s.splitArea?.files, 10);
    assert.ok(s.prompt.endsWith('\n\n---\n\nFind {{topic}}'));
    assert.ok(interpolateWorkflowVariables(s.prompt, definition.variables).endsWith('Find bugs'));
  });
});
for (const parallel of [false, true]) test(`group boundaries with parallel parent=${parallel} and parallel neighbors`, async () => {
  const neighbor = (id: string): WorkflowStep => ({ id, title: id, prompt: '', harness: 'claude', parallel: true });
  const { definition } = await expandWorkflowSplits(wf([neighbor('before'), { ...parent, parallel }, neighbor('after')]), async () => source);
  assert.deepEqual(nextStepGroup(definition.steps, 0), parallel ? { indices: [0, 1, 2, 3], end: 4 } : { indices: [0], end: 1 });
  if (!parallel) {
    assert.deepEqual(nextStepGroup(definition.steps, 1), { indices: [1, 2], end: 3 });
    assert.deepEqual(nextStepGroup(definition.steps, 3), { indices: [3], end: 4 });
  }
});
test('small, empty custom, and collector failure fall back without a scope or split; frozen retained', async () => {
  for (const collect of [async () => ({ ...source, files: source.files.slice(0, 3) }), async () => { throw new Error('unreadable'); }]) {
    const { definition, notes } = await expandWorkflowSplits(wf([{ ...parent, frozen: true }]), collect);
    assert.equal(definition.steps.length, 1); assert.equal(definition.steps[0].prompt, parent.prompt);
    assert.equal(definition.steps[0].split, undefined); assert.equal(definition.steps[0].frozen, true); assert.equal(notes.length, 1);
  }
  const custom = await expandWorkflowSplits(wf([{ ...parent, split: { mode: 'custom', areas: [], includeRest: false } }]), async () => source);
  assert.equal(custom.definition.steps.length, 1); assert.equal(custom.notes.length, 1);
});
test('custom scopes and split provenance persist; recovered definition does not collect/expand again', async () => {
  let scans = 0;
  const collect = async () => { scans++; return source; };
  const { definition } = await expandWorkflowSplits(wf([{ ...parent, split: { mode: 'custom', areas: [{ label: 'A', paths: ['a'] }], includeRest: true } }]), collect);
  assert.equal(definition.steps[1].splitArea?.label, 'Everything else');
  const run: WorkflowRun = { id: 'r', workflowId: 'wf', workflowName: 'Workflow', projectPath: process.cwd(), status: 'running', startedAt: 1, totalSteps: 2, currentStepIndex: 0, definition, notes: ['note'] };
  openStepGroup(run, definition.steps, nextStepGroup(definition.steps, 0)!);
  const recovered = deserializeWorkflowRun(JSON.parse(serializeWorkflowRuns([run])).runs[0])!;
  assert.equal(recovered.definitionError, undefined); assert.deepEqual(recovered.notes, ['note']);
  assert.deepEqual(recovered.definition?.steps.map((s) => s.splitArea), definition.steps.map((s) => s.splitArea));
  assert.ok(recovered.definition?.steps.every((s) => s.splitOf === 'parent' && s.splitGroup === 'parent'));
  await expandWorkflowSplits(recovered.definition!, collect);
  assert.equal(scans, 1, 'already expanded definition has no split configuration to resolve');
});

test('boot recovery redispatches persisted split members without replaying expansion', async () => {
  await withTempDir('split-resume-', async (dir) => {
    const projectPath = canonicalProjectPath(dir);
    const { definition } = await expandWorkflowSplits({ ...wf([parent]), projectPath }, async () => source);
    const run: WorkflowRun = { id: 'split_resume', workflowId: 'wf', workflowName: 'Workflow', projectPath, status: 'running', startedAt: 1, totalSteps: 2, currentStepIndex: 0, definition };
    openStepGroup(run, definition.steps, nextStepGroup(definition.steps, 0)!);
    const persisted = deserializeWorkflowRun(JSON.parse(serializeWorkflowRuns([run])).runs[0])!;
    const dispatched: number[] = [];
    try {
      await resumePersistedRun(persisted, [], '', false, { redispatchStep: async (_id, _origin, i) => { dispatched.push(i!); } });
      assert.deepEqual(dispatched.sort(), [0, 1]);
      assert.deepEqual(runs.get(run.id)?.definition?.steps.map((s) => [s.id, s.prompt]), definition.steps.map((s) => [s.id, s.prompt]));
      assert.equal(runs.get(run.id)?.totalSteps, 2);
    } finally {
      runs.delete(run.id);
      await flushWorkflowRunPersist(projectPath);
      await writeWorkflowRunsNow(projectPath, []);
    }
  });
});
