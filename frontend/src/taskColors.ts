// Per-task accent colors. Single source of truth shared by the taskboard
// card stripe, the 3D graph's Claude agent node, and the `W` worktree rings.
//
// A task's color is driven by its backend-assigned `colorIndex` — a stable
// palette slot (smallest free index among the project's active tasks, see
// backend `colorSlot.ts`). Slots are compact (a fleet of 80+ agents maps onto
// 0..N), so a golden-angle hue walk over the slot index keeps adjacent
// in-flight tasks maximally distinct without reshuffling when a sibling
// finishes. Tasks with no slot (legacy, or never run) fall back to a hash of
// the id so they still get a stable color.

import type { Task } from './api';

// Claude's brand coral/orange. Used for the free-floating node of a Claude
// session that runs OUTSIDE a task worktree (push / workflow step / post-
// merge hook) — those have no task color, so they're all the same Claude
// color by design.
export const CLAUDE_ORANGE = '#d97757';

// 137.508° — the golden angle. Successive multiples land far apart on the
// hue wheel and never tightly cluster, so even 80 slots stay separable.
const GOLDEN_ANGLE = 137.508;

// Three saturation/lightness bands, selected by index mod 3, so that two
// slots whose hues happen to land near each other still differ in value.
const SATURATION = [82, 68, 90];
const LIGHTNESS = [62, 71, 54];

export function colorForIndex(index: number): string {
  const i = Math.abs(Math.trunc(index));
  const hue = (i * GOLDEN_ANGLE) % 360;
  const band = i % 3;
  return `hsl(${hue.toFixed(1)}, ${SATURATION[band]}%, ${LIGHTNESS[band]}%)`;
}

// Stable non-negative hash of a task id, for the no-slot fallback.
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function taskColorIndex(task: Pick<Task, 'id' | 'colorIndex'>): number {
  if (typeof task.colorIndex === 'number' && task.colorIndex >= 0) {
    return task.colorIndex;
  }
  return hashId(task.id);
}

export function taskColor(task: Pick<Task, 'id' | 'colorIndex'>): string {
  return colorForIndex(taskColorIndex(task));
}
