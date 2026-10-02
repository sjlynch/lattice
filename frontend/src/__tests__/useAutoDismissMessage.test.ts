import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  TOAST_DISMISS_MS,
  useAutoDismissMessage,
} from '../components/shared/useAutoDismissMessage.ts';

// The shared toast slot behind `useTaskList`'s and `useWorkflowErrorHandler`'s
// `showError`: re-showing re-arms one timer, a timer only clears the message it
// was armed for, and unmount leaves no timer behind.

type Timer = { id: number; at: number; fn: () => void };

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let now: number;
let timers: Timer[];
let nextId: number;

beforeEach(() => {
  now = 0;
  timers = [];
  nextId = 1;
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.setTimeout = (fn: () => void, ms = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + ms, fn });
    return id;
  };
  g.clearTimeout = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

// Fire every fake timer due within `ms`, in order.
async function advance(ms: number) {
  const until = now + ms;
  for (;;) {
    const due = timers
      .filter((t) => t.at <= until)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    now = due.at;
    await act(async () => {
      due.fn();
    });
  }
  now = until;
}

let latest!: ReturnType<typeof useAutoDismissMessage>;
function Harness() {
  latest = useAutoDismissMessage();
  return null;
}

async function mount() {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  return renderer;
}

test('a message auto-dismisses after TOAST_DISMISS_MS', async () => {
  assert.equal(TOAST_DISMISS_MS, 5000);
  await mount();
  await act(async () => latest.show('boom'));
  assert.equal(latest.message, 'boom');
  await advance(TOAST_DISMISS_MS - 1);
  assert.equal(latest.message, 'boom');
  await advance(1);
  assert.equal(latest.message, null);
  assert.equal(timers.length, 0);
});

test('re-showing replaces the timer instead of stacking a second one', async () => {
  await mount();
  const { show } = latest;
  await act(async () => latest.show('first'));
  await advance(3000);
  await act(async () => latest.show('second'));
  assert.equal(timers.length, 1, 'the first timer was cleared');
  assert.equal(latest.show, show, 'show keeps a stable identity');

  // The first message's deadline passes without clearing the second one.
  await advance(TOAST_DISMISS_MS - 1);
  assert.equal(latest.message, 'second');
  await advance(1);
  assert.equal(latest.message, null);
});

test('a timer only clears the message it was armed for', async () => {
  await mount();
  await act(async () => latest.show('stale'));
  // Overwritten through the raw setter (no re-arm), as useTaskList's
  // `setError` does: the pending timer must leave the new message alone.
  await act(async () => latest.setMessage('fresh'));
  await advance(TOAST_DISMISS_MS);
  assert.equal(timers.length, 0);
  assert.equal(latest.message, 'fresh');
});

test('re-showing the same text still dismisses on the latest deadline', async () => {
  await mount();
  await act(async () => latest.show('same'));
  await advance(4000);
  await act(async () => latest.show('same'));
  await advance(4000);
  assert.equal(latest.message, 'same');
  await advance(1000);
  assert.equal(latest.message, null);
});

test('clear drops the message and its pending timer', async () => {
  await mount();
  await act(async () => latest.show('boom'));
  await act(async () => latest.clear());
  assert.equal(latest.message, null);
  assert.equal(timers.length, 0);
});

test('unmount clears the pending timer', async () => {
  const renderer = await mount();
  await act(async () => latest.show('boom'));
  assert.equal(timers.length, 1);
  await act(async () => renderer.unmount());
  assert.equal(timers.length, 0);
});
