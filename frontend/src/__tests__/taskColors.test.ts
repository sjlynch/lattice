import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorForIndex, taskColorIndex, taskColor } from '../taskColors.ts';

// taskColors is the single source of truth for the per-task accent colour shared
// by the task-board card stripe, the 3D graph's Claude agent node, and the `W`
// worktree rings. These constants MIRROR the (unexported) ones in taskColors.ts
// so the expected hsl() strings below are COMPUTED with the same formula, not
// hand-eyeballed — the test therefore also documents the exact output format.
const GOLDEN_ANGLE = 137.508;
const SATURATION = [82, 68, 90];
const LIGHTNESS = [62, 71, 54];

function expectedColor(index: number): string {
  const i = Math.abs(Math.trunc(index));
  const hue = (i * GOLDEN_ANGLE) % 360;
  const band = i % 3;
  return `hsl(${hue.toFixed(1)}, ${SATURATION[band]}%, ${LIGHTNESS[band]}%)`;
}

test('colorForIndex walks the golden-angle hue and cycles the mod-3 band', () => {
  // Indices 0..3 prove both the hue walk and the S/L band cycling. Explicit
  // literals pin the exact format; expectedColor() proves it is computed.
  assert.equal(colorForIndex(0), 'hsl(0.0, 82%, 62%)');
  assert.equal(colorForIndex(1), 'hsl(137.5, 68%, 71%)');
  assert.equal(colorForIndex(2), 'hsl(275.0, 90%, 54%)');
  assert.equal(colorForIndex(3), 'hsl(52.5, 82%, 62%)'); // hue wrapped past 360, band back to 0
  for (const i of [0, 1, 2, 3]) {
    assert.equal(colorForIndex(i), expectedColor(i));
  }
});

test('colorForIndex keeps the hue within [0, 360) for a large slot', () => {
  assert.equal(colorForIndex(80), expectedColor(80));
  const hue = Number(/^hsl\(([\d.]+),/.exec(colorForIndex(80))![1]);
  assert.ok(hue >= 0 && hue < 360, `hue ${hue} within [0, 360)`);
});

test('colorForIndex normalises negative and fractional indices via abs+trunc', () => {
  // Math.abs(Math.trunc(x)) maps -1, 1, and 1.9 all onto the index-1 colour.
  const one = colorForIndex(1);
  assert.equal(colorForIndex(-1), one);
  assert.equal(colorForIndex(1.9), one);
  assert.equal(one, expectedColor(1));
});

test('taskColorIndex returns a non-negative colorIndex verbatim', () => {
  assert.equal(taskColorIndex({ id: 't_a', colorIndex: 0 }), 0);
  assert.equal(taskColorIndex({ id: 't_b', colorIndex: 77 }), 77);
});

test('taskColorIndex falls back to a stable id hash when there is no slot', () => {
  // colorIndex undefined (legacy) or -1 (never-run) → hashId(id) fallback.
  const undef = taskColorIndex({ id: 'task-alpha' });
  const legacy = taskColorIndex({ id: 'task-alpha', colorIndex: -1 });

  // Stable non-negative integer, and the same for both no-slot forms of one id.
  assert.ok(Number.isInteger(undef) && undef >= 0);
  assert.equal(undef, legacy);

  // Deterministic for the same id across calls.
  assert.equal(taskColorIndex({ id: 'task-alpha' }), undef);

  // Two distinct ids generally hash to different slots.
  assert.notEqual(
    taskColorIndex({ id: 'task-alpha' }),
    taskColorIndex({ id: 'task-beta' }),
  );
});

test('taskColor equals colorForIndex(taskColorIndex(task))', () => {
  const slotted = { id: 't_c', colorIndex: 5 };
  assert.equal(taskColor(slotted), colorForIndex(taskColorIndex(slotted)));

  const fallback = { id: 'task-gamma' };
  assert.equal(taskColor(fallback), colorForIndex(taskColorIndex(fallback)));
});
