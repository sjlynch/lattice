import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeForceGraphLifecycle } from '../components/forceGraph/hooks/forceGraphInitializationLifecycle.ts';
import { describeRendererFailure } from '../components/forceGraph/rendererStatus.ts';

const configurationStages = [
  'background', 'node-id', 'camera', 'right-click-guard', 'renderer',
] as const;
const registrationStages = [
  'resize', 'idle', 'attach-idle', 'frame-driver', 'motion-driver',
  'frame-subscription', 'engine-start', 'engine-stop', 'canvas',
  'context-lost', 'context-restored',
] as const;
type SetupStage = 'constructor'
  | typeof configurationStages[number]
  | typeof registrationStages[number];
const cleanupOrder = [
  'context-lost', 'context-restored', 'frame-subscription', 'idle', 'resize',
  'labels', 'graph', 'shared-resources', 'context-loss',
] as const;
// Released for any graph the constructor returned, however far setup got.
const graphOwnedStages: readonly string[] = [
  'labels', 'graph', 'shared-resources', 'context-loss',
];
type CleanupStage = typeof cleanupOrder[number] | 'container';

type FakeRenderer = { forceContextLoss(): void };
type FakeGraph = {
  backgroundColor(): FakeGraph;
  nodeId(): FakeGraph;
  _destructor(): void;
  renderer?: () => FakeRenderer | null;
};

function fixture({
  failAt,
  cleanupErrors = {},
  children = [],
  withRenderer = true,
  withSharedResources = true,
}: {
  failAt?: SetupStage;
  cleanupErrors?: Partial<Record<CleanupStage, unknown>>;
  children?: string[];
  // A graph exposing `renderer()` owns a WebGL context ('context-loss').
  withRenderer?: boolean;
  // Supplies the optional `disposeSharedResources` lifecycle option.
  withSharedResources?: boolean;
} = {}) {
  const failure = new Error(
    failAt === 'constructor' ? 'Error creating WebGL context.' : `failed at ${failAt}`,
  );
  const setup: SetupStage[] = [];
  const cleanup: CleanupStage[] = [];
  const active = new Set<string>();
  const acquired: string[] = [];
  const reports: unknown[] = [];
  const step = (stage: SetupStage) => {
    setup.push(stage);
    if (stage === failAt) throw failure;
  };
  const release = (stage: CleanupStage) => {
    cleanup.push(stage);
    active.delete(stage);
    if (Object.hasOwn(cleanupErrors, stage)) throw cleanupErrors[stage];
  };
  const acquire = (stage: SetupStage & CleanupStage) => {
    step(stage);
    active.add(stage);
    acquired.push(stage);
    return () => release(stage);
  };
  let destroyed = false;
  let rendererCalls = 0;
  const webglRenderer: FakeRenderer = {
    forceContextLoss() {
      assert.equal(this, webglRenderer);
      release('context-loss');
    },
  };
  const graph: FakeGraph = {
    backgroundColor() {
      step('background');
      return this;
    },
    nodeId() {
      step('node-id');
      return this;
    },
    _destructor() {
      // The real library destructor is a method; keep its receiver intact.
      assert.equal(this, graph);
      destroyed = true;
      children.length = 0;
      release('graph');
    },
  };
  if (withRenderer) {
    graph.renderer = () => {
      rendererCalls++;
      // Library state may be gone after the destructor, so teardown must
      // capture the renderer before destroying the graph.
      return destroyed ? null : webglRenderer;
    };
  }
  const graphRef: { current: typeof graph | null } = { current: null };
  const options: Parameters<typeof initializeForceGraphLifecycle<typeof graph>>[0] = {
    container: {
      replaceChildren() {
        children.length = 0;
        release('container');
      },
    },
    graphRef,
    createGraph() {
      // Constructor refusal can still leave DOM behind without returning an
      // instance. The caller must clear it without claiming graph ownership.
      children.push('canvas', 'nav');
      step('constructor');
      active.add('graph');
      if (withRenderer) active.add('context-loss');
      return graph;
    },
    configureGraph(instance) {
      assert.equal(instance, graph);
      assert.equal(graphRef.current, null);
      instance.backgroundColor().nodeId();
      step('camera');
      step('right-click-guard');
      step('renderer');
    },
    registerResources(instance, owned) {
      assert.equal(instance, graph);
      assert.equal(graphRef.current, graph);
      owned.teardownResize = acquire('resize');
      owned.destroyIdle = acquire('idle');
      step('attach-idle');
      step('frame-driver');
      step('motion-driver');
      owned.offThrottleFrame = acquire('frame-subscription');
      step('engine-start');
      step('engine-stop');
      step('canvas');
      owned.removeContextLost = acquire('context-lost');
      owned.removeContextRestored = acquire('context-restored');
    },
    clearLabels: () => release('labels'),
    onRendererFailure(error) {
      // Ref/DOM cleanup must happen before the coordinator is notified.
      assert.equal(graphRef.current, null);
      assert.deepEqual(children, []);
      reports.push(error);
    },
  };
  if (withSharedResources) {
    options.disposeSharedResources = () => release('shared-resources');
  }
  return {
    options, graph, graphRef, failure, setup, cleanup, active, acquired, children, reports,
    rendererCalls: () => rendererCalls,
  };
}

const count = (stages: readonly string[], stage: CleanupStage) =>
  stages.filter((s) => s === stage).length;

for (const failAt of configurationStages) {
  test(`failure at ${failAt} destroys the captured instance once and clears ref/DOM`, () => {
    const f = fixture({ failAt });
    assert.equal(initializeForceGraphLifecycle(f.options), undefined);
    // The graph exists, so its rollback also disposes shared resources and
    // loses the WebGL context.
    assert.deepEqual(f.cleanup, [
      'labels', 'graph', 'shared-resources', 'context-loss', 'container',
    ]);
    assert.equal(f.active.size, 0);
    assert.equal(f.graphRef.current, null);
    assert.deepEqual(f.children, []);
    assert.deepEqual(f.reports, [f.failure]);
  });
}

for (const failAt of registrationStages) {
  test(`failure at ${failAt} releases only the resources acquired so far`, () => {
    const f = fixture({ failAt });
    assert.equal(initializeForceGraphLifecycle(f.options), undefined);
    const expected = cleanupOrder.filter((stage) =>
      graphOwnedStages.includes(stage) || f.acquired.includes(stage),
    );
    assert.deepEqual(f.cleanup, [...expected, 'container']);
    assert.equal(f.active.size, 0);
    assert.equal(f.graphRef.current, null);
    assert.deepEqual(f.children, []);
    assert.deepEqual(f.reports, [f.failure]);
  });
}

test('normal unmount keeps setup/teardown order and destructor ownership is exactly once', () => {
  const f = fixture();
  const unmount = initializeForceGraphLifecycle(f.options);
  assert.equal(typeof unmount, 'function');
  assert.deepEqual(f.setup, ['constructor', ...configurationStages, ...registrationStages]);
  assert.equal(f.graphRef.current, f.graph);
  assert.equal(f.active.size, 7);
  assert.deepEqual(f.children, ['canvas', 'nav']);
  assert.deepEqual(f.cleanup, []);
  assert.deepEqual(f.reports, []);

  unmount!();
  unmount!();
  assert.deepEqual(f.cleanup, cleanupOrder);
  assert.equal(f.active.size, 0);
  assert.equal(f.graphRef.current, null);
  assert.deepEqual(f.children, []);
});

test('constructor refusal reports the existing recoverable failure without destroying an instance', () => {
  const f = fixture({ failAt: 'constructor' });
  assert.equal(initializeForceGraphLifecycle(f.options), undefined);
  assert.deepEqual(f.setup, ['constructor']);
  assert.deepEqual(f.cleanup, ['container']);
  assert.equal(f.rendererCalls(), 0, 'no renderer to capture or lose');
  assert.deepEqual(f.reports, [f.failure]);
  assert.deepEqual(describeRendererFailure(f.reports[0]), {
    kind: 'unavailable',
    message: 'Error creating WebGL context.',
    webgl: true,
  });
});

test('cleanup faults cannot suppress later cleanup or the original setup failure report', () => {
  const cleanupFailure = new Error('cleanup failed');
  const f = fixture({
    failAt: 'context-restored',
    cleanupErrors: Object.fromEntries(cleanupOrder.map((stage) => [stage, cleanupFailure])),
  });
  assert.equal(initializeForceGraphLifecycle(f.options), undefined);
  assert.deepEqual(f.cleanup, [
    'context-lost', 'frame-subscription', 'idle', 'resize', 'labels', 'graph',
    'shared-resources', 'context-loss', 'container',
  ]);
  assert.equal(f.active.size, 0);
  assert.deepEqual(f.reports, [f.failure]);
});

test('even a container cleanup fault leaves the original failure report intact', () => {
  const f = fixture({
    failAt: 'constructor',
    cleanupErrors: { container: new Error('container cleanup failed') },
  });
  assert.equal(initializeForceGraphLifecycle(f.options), undefined);
  assert.deepEqual(f.cleanup, ['container']);
  assert.deepEqual(f.reports, [f.failure]);
});

test('normal cleanup propagates its first error after attempting every release exactly once', () => {
  const firstError = new Error('context listener cleanup failed');
  const f = fixture({
    cleanupErrors: {
      'context-lost': firstError,
      idle: new Error('idle cleanup failed'),
      graph: new Error('destructor failed'),
    },
  });
  const unmount = initializeForceGraphLifecycle(f.options)!;
  assert.throws(unmount, (error) => error === firstError);
  assert.doesNotThrow(unmount);
  assert.deepEqual(f.cleanup, cleanupOrder);
  assert.equal(f.active.size, 0);
  assert.equal(f.graphRef.current, null);
  assert.deepEqual(f.reports, []);
});

test('a fresh mount after failure owns a new instance independently', () => {
  const failed = fixture({ failAt: 'node-id' });
  initializeForceGraphLifecycle(failed.options);
  const retry = fixture({ children: failed.children });
  // Retry remounts the coordinator; the failed effect never returns a cleanup
  // that could destroy the replacement graph later.
  const unmount = initializeForceGraphLifecycle(retry.options)!;
  assert.notEqual(failed.graph, retry.graph);
  assert.equal(failed.graphRef.current, null);
  assert.equal(retry.graphRef.current, retry.graph);
  unmount();
  assert.equal(failed.cleanup.filter((stage) => stage === 'graph').length, 1);
  assert.equal(retry.cleanup.filter((stage) => stage === 'graph').length, 1);
});

test('normal unmount loses the WebGL context once, after the destructor and shared resources', () => {
  const f = fixture();
  const unmount = initializeForceGraphLifecycle(f.options)!;
  unmount();
  unmount();
  // The fake renderer reads null once destroyed, so losing its context proves
  // it was captured before the destructor ran.
  assert.deepEqual(f.cleanup.slice(-3), ['graph', 'shared-resources', 'context-loss']);
  assert.equal(count(f.cleanup, 'context-loss'), 1);
  assert.equal(count(f.cleanup, 'shared-resources'), 1);
  assert.equal(f.rendererCalls(), 1);
  assert.equal(f.active.size, 0);
});

test('a throwing destructor still disposes shared resources and loses the context', () => {
  const destructorError = new Error('destructor failed');
  const f = fixture({ cleanupErrors: { graph: destructorError } });
  const unmount = initializeForceGraphLifecycle(f.options)!;
  assert.throws(unmount, (error) => error === destructorError);
  assert.doesNotThrow(unmount);
  assert.deepEqual(f.cleanup, cleanupOrder);
  assert.equal(count(f.cleanup, 'shared-resources'), 1);
  assert.equal(count(f.cleanup, 'context-loss'), 1);
  assert.equal(f.active.size, 0);
  assert.equal(f.graphRef.current, null);
});

test('a throwing forceContextLoss neither skips clearing graphRef nor masks an earlier error', () => {
  const firstError = new Error('context listener cleanup failed');
  const lossError = new Error('forceContextLoss failed');
  const f = fixture({
    cleanupErrors: { 'context-lost': firstError, 'context-loss': lossError },
  });
  const unmount = initializeForceGraphLifecycle(f.options)!;
  assert.throws(unmount, (error) => error === firstError);
  assert.deepEqual(f.cleanup, cleanupOrder);
  assert.equal(f.graphRef.current, null);

  // Alone, its error is the one normal unmount propagates.
  const alone = fixture({ cleanupErrors: { 'context-loss': lossError } });
  assert.throws(initializeForceGraphLifecycle(alone.options)!, (error) => error === lossError);
  assert.deepEqual(alone.cleanup, cleanupOrder);
  assert.equal(alone.graphRef.current, null);

  // On failed setup it cannot replace the original report or skip the container.
  const failed = fixture({ failAt: 'renderer', cleanupErrors: { 'context-loss': lossError } });
  assert.equal(initializeForceGraphLifecycle(failed.options), undefined);
  assert.deepEqual(failed.cleanup.slice(-2), ['context-loss', 'container']);
  assert.deepEqual(failed.children, []);
  assert.deepEqual(failed.reports, [failed.failure]);
});

test('a throwing shared-resource dispose cannot skip the context loss', () => {
  const sharedError = new Error('shared dispose failed');
  const f = fixture({ cleanupErrors: { 'shared-resources': sharedError } });
  const unmount = initializeForceGraphLifecycle(f.options)!;
  assert.throws(unmount, (error) => error === sharedError);
  assert.deepEqual(f.cleanup, cleanupOrder);
  assert.equal(f.active.size, 0);
  assert.equal(f.graphRef.current, null);
});

test('without a renderer or shared-resource option, teardown is unchanged', () => {
  const f = fixture({ withRenderer: false, withSharedResources: false });
  const unmount = initializeForceGraphLifecycle(f.options)!;
  assert.equal(f.active.size, 6);
  unmount();
  assert.deepEqual(f.cleanup, [
    'context-lost', 'context-restored', 'frame-subscription', 'idle', 'resize',
    'labels', 'graph',
  ]);
  assert.equal(f.active.size, 0);
  assert.equal(f.graphRef.current, null);

  const failed = fixture({ failAt: 'camera', withRenderer: false, withSharedResources: false });
  assert.equal(initializeForceGraphLifecycle(failed.options), undefined);
  assert.deepEqual(failed.cleanup, ['labels', 'graph', 'container']);
  assert.deepEqual(failed.reports, [failed.failure]);
});

test('shared resources are disposed once per graph teardown, never for a refused constructor', () => {
  const refused = fixture({ failAt: 'constructor' });
  initializeForceGraphLifecycle(refused.options);
  assert.equal(count(refused.cleanup, 'shared-resources'), 0);

  const failed = fixture({ failAt: 'frame-driver' });
  initializeForceGraphLifecycle(failed.options);
  assert.equal(count(failed.cleanup, 'shared-resources'), 1);

  // A project switch: the old graph's cleanup runs before the new one mounts.
  const first = fixture();
  const second = fixture();
  const unmountFirst = initializeForceGraphLifecycle(first.options)!;
  unmountFirst();
  const unmountSecond = initializeForceGraphLifecycle(second.options)!;
  assert.equal(count(second.cleanup, 'shared-resources'), 0, 'mounting never disposes');
  unmountSecond();
  unmountFirst();
  assert.equal(count(first.cleanup, 'shared-resources'), 1);
  assert.equal(count(second.cleanup, 'shared-resources'), 1);
});
