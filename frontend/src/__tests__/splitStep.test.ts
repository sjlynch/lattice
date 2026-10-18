// Splitting a planner must preserve all authored settings while giving each
// parallel copy its own identity, scope and the untouched original prompt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceArea, WorkflowStep } from '../api';
import { splitStep } from '../components/workflows/splitStep';
import { renderAreaScope } from '../../../backend/src/shared/sourceAreas';

test('split copies retain fields and add ordered scopes, fresh ids and parallel=true', () => {
  const original: WorkflowStep = {
    id: 'original', kind: 'agent', title: 'Bug catcher', prompt: 'Find bugs.\n\n{{user_instructions}}',
    harness: 'pi', model: 'custom', effort: 'high', piModel: 'provider/model',
    frozen: true, tools: ['opengrep'], timeoutMinutes: 20, tasksHarness: 'codex', tasksPiModel: 'other/model',
  };
  const areas: SourceArea[] = [
    { paths: ['backend/src'], files: 90, label: 'backend/src' },
    { paths: ['frontend/*', 'frontend/src'], files: 100, label: 'frontend/* … frontend/src' },
  ];
  const before = structuredClone(original);
  for (const parallel of [undefined, true] as const) {
    const step = { ...original, parallel };
    const copies = splitStep(step, areas, 'new-split');
    assert.deepEqual(splitStep(step, areas, 'new-split'), copies);
    assert.equal(copies.length, 2);
    assert.equal(new Set([step.id, ...copies.map((copy) => copy.id)]).size, 3);
    copies.forEach((copy, i) => {
      assert.deepEqual(copy, {
        ...step, id: copy.id, title: `${step.title} · ${areas[i].label}`,
        prompt: `${renderAreaScope(areas[i])}\n\n---\n\n${step.prompt}`, parallel: true,
      });
    });
  }
  assert.deepEqual(original, before);
});
