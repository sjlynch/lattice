import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCanvasDocument } from './domDoubles.ts';

// The layout module's import graph reaches the label texture/sprite caches,
// which build canvases at module load — install the canvas stub first.
installCanvasDocument((t) => ({
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: t.length * 10,
  width: t.length * 10,
}));

const { spreadLabelRects } = await import(
  '../components/forceGraph/agentOverlayLabelLayout.ts'
);

type Item = Parameters<typeof spreadLabelRects>[0][number];

function overlaps(a: { cx: number; cy: number }, ai: Item, b: { cx: number; cy: number }, bi: Item) {
  return (
    Math.abs(a.cx - b.cx) < (ai.w + bi.w) / 2 &&
    Math.abs(a.cy - b.cy) < (ai.h + bi.h) / 2
  );
}

test('an uncontested label sits at its preferred spot beside its node', () => {
  const items: Item[] = [{ ax: 0, ay: 0, w: 10, h: 2, side: 1, gap: 1, dy: 0.5 }];
  const [o] = spreadLabelRects(items, 0, 0);
  assert.equal(o.cx, 6); // near edge at ax + gap, centre half a width further
  assert.equal(o.cy, 0.5);
});

test('left-side labels extend leftward from their node', () => {
  const items: Item[] = [{ ax: 0, ay: 0, w: 10, h: 2, side: -1, gap: 1, dy: 0 }];
  const [o] = spreadLabelRects(items, 0, 0);
  assert.equal(o.cx, -6);
});

test('stacked nodes with colliding labels are spread apart vertically', () => {
  // Three satellites almost on top of each other, all labelling to the right.
  const items: Item[] = [
    { ax: 0, ay: 0, w: 10, h: 2, side: 1, gap: 1, dy: 0 },
    { ax: 0.5, ay: 0.3, w: 8, h: 2, side: 1, gap: 1, dy: 0 },
    { ax: 0.2, ay: -0.2, w: 12, h: 2, side: 1, gap: 1, dy: 0 },
  ];
  const out = spreadLabelRects(items, 0.1, 0.2);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      assert.ok(!overlaps(out[i], items[i], out[j], items[j]), `labels ${i} and ${j} overlap`);
    }
  }
  // Horizontal placement never changes — each label stays beside its node.
  items.forEach((it, i) => assert.equal(out[i].cx, it.ax + it.side * (it.gap + it.w / 2)));
});

test('labels on opposite sides of a node do not disturb each other', () => {
  const items: Item[] = [
    { ax: 0, ay: 0, w: 10, h: 2, side: 1, gap: 1, dy: 0 },
    { ax: 0, ay: 0, w: 10, h: 2, side: -1, gap: 1, dy: 0 },
  ];
  const out = spreadLabelRects(items, 0.1, 0.1);
  assert.equal(out[0].cy, 0);
  assert.equal(out[1].cy, 0);
});
