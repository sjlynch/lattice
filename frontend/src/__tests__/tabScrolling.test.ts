import { test } from 'node:test';
import assert from 'node:assert/strict';

// No DOM under `node --test`, so stub ResizeObserver just enough for
// subscribeTabScroll to construct + observe + disconnect one. (We don't drive
// resize callbacks here — the scroll path is what the regression covers.)
class FakeResizeObserver {
  observed: unknown[] = [];
  constructor(_cb: () => void) {}
  observe(el: unknown) {
    this.observed.push(el);
  }
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  FakeResizeObserver;

const { computeTabScrollState, subscribeTabScroll } = await import(
  '../components/sidebar/hooks/useTabScrolling.ts'
);

// A stand-in for the real <div className="sidebar-tabs"> strip: just the scroll
// geometry plus a recorded set of 'scroll' listeners we can fire by hand.
function makeFakeStrip(metrics: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}) {
  const listeners = new Set<() => void>();
  return {
    ...metrics,
    addEventListener(type: 'scroll', handler: () => void) {
      if (type === 'scroll') listeners.add(handler);
    },
    removeEventListener(type: 'scroll', handler: () => void) {
      if (type === 'scroll') listeners.delete(handler);
    },
    fireScroll() {
      for (const h of listeners) h();
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

test('computeTabScrollState derives arrow state from scroll geometry', () => {
  assert.deepEqual(computeTabScrollState(null), {
    canScrollLeft: false,
    canScrollRight: false,
  });
  // Overflowing strip pinned at the left edge: only right is reachable.
  assert.deepEqual(
    computeTabScrollState({ scrollLeft: 0, scrollWidth: 500, clientWidth: 200 }),
    { canScrollLeft: false, canScrollRight: true },
  );
  // Scrolled fully to the right: only left is reachable.
  assert.deepEqual(
    computeTabScrollState({ scrollLeft: 300, scrollWidth: 500, clientWidth: 200 }),
    { canScrollLeft: true, canScrollRight: false },
  );
  // No overflow: neither arrow is active.
  assert.deepEqual(
    computeTabScrollState({ scrollLeft: 0, scrollWidth: 200, clientWidth: 200 }),
    { canScrollLeft: false, canScrollRight: false },
  );
});

// Regression: the sidebar mounts with zero terminals (no strip), so the
// scroll-listener effect originally bailed at `if (!el) return` and — being
// keyed only on a permanently-stable callback — never re-attached after the
// strip later mounted. The effect now re-subscribes via subscribeTabScroll once
// the strip exists, so a 'scroll' event after scrolling must update the arrow
// state. Here we drive that subscription directly: subscribe, scroll right,
// dispatch 'scroll', and assert canScrollLeft flips on.
test('a scroll event on the strip updates the arrow state once subscribed', () => {
  // Overflowing strip, parked at the left edge — left arrow starts disabled.
  const strip = makeFakeStrip({ scrollLeft: 0, scrollWidth: 500, clientWidth: 200 });

  let state = computeTabScrollState(strip);
  assert.deepEqual(state, { canScrollLeft: false, canScrollRight: true });

  const detach = subscribeTabScroll(strip, () => {
    state = computeTabScrollState(strip);
  });
  assert.equal(strip.listenerCount(), 1, 'scroll listener should be attached');

  // Click the right arrow: scrollBy advances scrollLeft and the browser emits a
  // 'scroll' event. Without the listener (the original bug) state would stay put.
  strip.scrollLeft = 160;
  strip.fireScroll();
  assert.equal(state.canScrollLeft, true, 'left arrow should enable after scrolling');
  assert.equal(state.canScrollRight, true, 'still room to the right');

  // Scroll to the far right: left stays enabled, right disables.
  strip.scrollLeft = 300;
  strip.fireScroll();
  assert.deepEqual(state, { canScrollLeft: true, canScrollRight: false });

  // Teardown removes the listener so a later fire is inert.
  detach();
  assert.equal(strip.listenerCount(), 0, 'detach should remove the scroll listener');
  strip.scrollLeft = 0;
  strip.fireScroll();
  assert.deepEqual(
    state,
    { canScrollLeft: true, canScrollRight: false },
    'state is frozen after detach',
  );
});
