import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { createLoopScheduler } from '../components/forceGraph/idleControllerLoop.ts';
import { installManualTimers } from './domDoubles.ts';

test('destroy fences a queued throttle microtask so it cannot resurrect the disposed graph', async () => {
  const timers = installManualTimers();
  let pauses = 0;
  let resumes = 0;
  const graph = { pauseAnimation: () => pauses++, resumeAnimation: () => resumes++ } as unknown as ForceGraph3DInstance;
  const loop = createLoopScheduler(graph, () => true, () => true);
  try {
    loop.notifyFrameRendered();
    loop.destroy();
    await Promise.resolve();
    assert.equal(pauses, 0, 'no callbacks may touch a destroyed WebGL graph');
    assert.equal(timers.scheduled.length, 0);
    loop.sync();
    loop.notifyFrameRendered();
    await Promise.resolve();
    timers.fireAll();
    assert.equal(resumes, 0, 'late overlay cleanup must not restart rendering');
  } finally { loop.destroy(); timers.restore(); }
});

test('destroy cancels an already-scheduled slow frame and normal throttle still resumes', async () => {
  const timers = installManualTimers();
  let resumes = 0;
  const graph = { pauseAnimation: () => {}, resumeAnimation: () => resumes++ } as unknown as ForceGraph3DInstance;
  const loop = createLoopScheduler(graph, () => true, () => true);
  try {
    loop.notifyFrameRendered();
    await Promise.resolve();
    assert.equal(timers.scheduled.length, 1);
    timers.fireAll();
    assert.equal(resumes, 1);
    loop.notifyFrameRendered();
    await Promise.resolve();
    loop.destroy();
    timers.fireAll();
    assert.equal(resumes, 1);
    assert.equal(timers.scheduled.length, 0);
  } finally { loop.destroy(); timers.restore(); }
});
