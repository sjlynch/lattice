import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { applyCrossFile } from '../health/crossFile/apply.js';
import { computeCrossFile, type CrossFileResult } from '../health/crossFile/graph.js';
import { CrossFileAnalyzer } from '../health/crossFileAnalyzer.js';
import { computeScore } from '../health/score.js';
import { SMELL_LABELS, type DeadCodeStatus, type HealthMetrics, type HealthSmell, type HealthSmellId } from '../health/types.js';
import { minimalMetrics, smellCount } from './helpers/health.js';

const root = path.resolve('health-cross-file-apply-fixture');
const file = path.join(root, 'index.ts');

function smell(id: HealthSmellId, count: number): HealthSmell {
  return { id, count, label: SMELL_LABELS[id] };
}

function result(fanIn: number, fanOut: number, inCycle = false, deadCode?: DeadCodeStatus): CrossFileResult {
  return {
    fanIn: new Map([[file, fanIn]]),
    fanOut: new Map([[file, fanOut]]),
    inCycle: new Set(inCycle ? [file] : []),
    deadCode: new Map(deadCode ? [[file, deadCode]] : []),
    reachable: new Set(),
    totalEdges: 0,
  };
}

test('changed cross-file recomputations keep each warning at one and preserve per-file counts', () => {
  const ownSmells = [smell('console_log', 3), smell('todo_fixme', 2)];
  const m = minimalMetrics({ loc: 100, smells: ownSmells, smellCount: 5 });
  const metrics = new Map([[file, m]]);

  for (const [fanIn, fanOut] of [[31, 26], [32, 26], [32, 27], [31, 26]]) {
    applyCrossFile(metrics, result(fanIn, fanOut, true, 'live'));
    assert.equal(smellCount(m, 'circular_dependency'), 1);
    assert.equal(smellCount(m, 'high_fan_in'), 1);
    assert.equal(smellCount(m, 'high_fan_out'), 1);
    assert.deepEqual(m.smells.filter((s) => s.id === 'console_log' || s.id === 'todo_fixme'), ownSmells);
    assert.equal(m.smellCount, 8);
  }

  const scoreBefore = m.score;
  applyCrossFile(metrics, result(31, 26, true, 'dead'));
  assert.equal(m.deadCode, 'dead');
  assert.equal(m.smellCount, 8, 'a reachability-only update cannot accumulate warnings');
  assert.equal(m.score, scoreBefore, 'dead-code classification is not a score penalty');

  const stableSmells = m.smells;
  applyCrossFile(metrics, result(31, 26, true, 'dead'));
  assert.strictEqual(m.smells, stableSmells, 'unchanged normalized metrics retain their smell array');
});

test('fan warnings disappear independently at their exact threshold boundaries', () => {
  const m = minimalMetrics({ smells: [smell('todo_fixme', 2)], smellCount: 2 });
  const metrics = new Map([[file, m]]);
  const cases = [
    { fanIn: 31, fanOut: 26, highIn: 1, highOut: 1 },
    { fanIn: 31, fanOut: 25, highIn: 1, highOut: 0 },
    { fanIn: 30, fanOut: 26, highIn: 0, highOut: 1 },
    { fanIn: 30, fanOut: 25, highIn: 0, highOut: 0 },
  ];
  for (const { fanIn, fanOut, highIn, highOut } of cases) {
    applyCrossFile(metrics, result(fanIn, fanOut));
    assert.equal(smellCount(m, 'high_fan_in'), highIn, `fanIn ${fanIn}`);
    assert.equal(smellCount(m, 'high_fan_out'), highOut, `fanOut ${fanOut}`);
    assert.equal(smellCount(m, 'todo_fixme'), 2);
    assert.equal(m.smellCount, 2 + highIn + highOut);
  }
});

test('breaking a real import cycle removes both files\' cycle warnings and restores scores', () => {
  const other = path.join(root, 'other.ts');
  const a = minimalMetrics({ loc: 100, smells: [smell('todo_fixme', 1)], smellCount: 1 });
  const b = minimalMetrics({ loc: 100 });
  const metrics = new Map([[file, a], [other, b]]);
  const present = new Set(metrics.keys());

  applyCrossFile(metrics, computeCrossFile([
    { filePath: file, imports: ['./other'] },
    { filePath: other, imports: ['./index'] },
  ], present));
  assert.equal(smellCount(a, 'circular_dependency'), 1);
  assert.equal(smellCount(b, 'circular_dependency'), 1);
  const scoresWithCycle = [a.score, b.score];

  applyCrossFile(metrics, computeCrossFile([
    { filePath: file, imports: ['./other'] },
    { filePath: other, imports: [] },
  ], present));
  assert.equal(a.inCycle, false);
  assert.equal(b.inCycle, false);
  assert.equal(smellCount(a, 'circular_dependency'), 0);
  assert.equal(smellCount(b, 'circular_dependency'), 0);
  assert.deepEqual(a.smells, [smell('todo_fixme', 1)]);
  assert.deepEqual(b.smells, []);
  assert.equal(a.smellCount, 1);
  assert.equal(b.smellCount, 0);
  assert.ok(a.score > scoresWithCycle[0]);
  assert.ok(b.score > scoresWithCycle[1]);
});

test('first unchanged pass repairs hydrated stale warnings and their score without reanalysis', () => {
  // Persisted post-cross-file metrics already have all graph fields. Reusing
  // those exact inputs used to take the fast path and keep these old counts.
  const cached = minimalMetrics({
    loc: 100,
    fanIn: 30,
    fanOut: 25,
    inCycle: false,
    deadCode: 'entry',
    smells: [
      smell('circular_dependency', 5),
      smell('high_fan_in', 4),
      smell('high_fan_out', 3),
      smell('todo_fixme', 2),
    ],
    smellCount: 14,
  });
  cached.score = computeScore(cached);
  const hydrated: HealthMetrics = JSON.parse(JSON.stringify(cached));
  const metrics = new Map([[file, hydrated]]);
  applyCrossFile(metrics, result(30, 25, false, 'entry'));

  assert.deepEqual(hydrated.smells, [smell('todo_fixme', 2)]);
  assert.equal(hydrated.smellCount, 2);
  assert.ok(hydrated.score > cached.score, 'corrected smell density repairs the score too');
  const repairedSmells = hydrated.smells;
  applyCrossFile(metrics, result(30, 25, false, 'entry'));
  assert.strictEqual(hydrated.smells, repairedSmells);

  // A new hydration must also normalize, even at the same file path after a
  // previous object was repaired; no global path-based migration marker.
  const hydratedAgain: HealthMetrics = JSON.parse(JSON.stringify(cached));
  applyCrossFile(new Map([[file, hydratedAgain]]), result(30, 25, false, 'entry'));
  assert.deepEqual(hydratedAgain.smells, [smell('todo_fixme', 2)]);
});

test('first unchanged pass normalizes still-active cached warnings to one', () => {
  const m = minimalMetrics({
    fanIn: 31,
    fanOut: 26,
    inCycle: true,
    smells: [smell('circular_dependency', 5), smell('high_fan_in', 4), smell('high_fan_out', 3)],
    smellCount: 12,
  });
  applyCrossFile(new Map([[file, m]]), result(31, 26, true));
  assert.equal(smellCount(m, 'circular_dependency'), 1);
  assert.equal(smellCount(m, 'high_fan_in'), 1);
  assert.equal(smellCount(m, 'high_fan_out'), 1);
  assert.equal(m.smellCount, 3);
});

test('watcher broadcasts repaired warning counts even when graph fields and score stay unchanged', () => {
  const m = minimalMetrics({
    fanIn: 0,
    fanOut: 0,
    inCycle: true,
    deadCode: 'entry',
    smells: [smell('circular_dependency', 7)],
    smellCount: 7,
  });
  const updates: Array<{ filePath: string; count: number; score: number }> = [];
  const analyzer = new CrossFileAnalyzer({
    imports: new Map([[file, ['./index']]]),
    metrics: new Map([[file, m]]),
    getAliases: () => [],
    broadcastUpdated: (filePath, metrics) => {
      updates.push({ filePath, count: metrics.smellCount, score: metrics.score });
    },
    projectRoot: root,
    entryGlobs: [],
    packageRoots: new Set(),
  });

  analyzer.recomputeAndBroadcast(null);
  assert.deepEqual(updates, [{ filePath: file, count: 1, score: 100 }]);
  const stableSmells = m.smells;
  analyzer.recomputeAndBroadcast(null);
  assert.strictEqual(m.smells, stableSmells);
  assert.equal(updates.length, 1, 'steady recomputations do not rebroadcast normalized files');
});

test('reachability-only changes broadcast the affected file once and preserve unaffected arrays', () => {
  const other = path.join(root, 'other.ts');
  const mainMetrics = minimalMetrics();
  const otherMetrics = minimalMetrics();
  const packageRoots = new Set([other]);
  const updates: string[] = [];
  const analyzer = new CrossFileAnalyzer({
    imports: new Map([[file, []], [other, []]]),
    metrics: new Map([[file, mainMetrics], [other, otherMetrics]]),
    getAliases: () => [],
    broadcastUpdated: (filePath) => { updates.push(filePath); },
    projectRoot: root,
    entryGlobs: [],
    packageRoots,
  });
  analyzer.recomputeAndBroadcast(null);
  assert.equal(otherMetrics.deadCode, 'entry');
  const mainSmells = mainMetrics.smells;
  updates.length = 0;

  packageRoots.delete(other);
  analyzer.invalidateRoots();
  analyzer.recomputeAndBroadcast(null);
  assert.equal(otherMetrics.deadCode, 'dead');
  assert.equal(otherMetrics.fanIn, 0);
  assert.equal(otherMetrics.fanOut, 0);
  assert.equal(otherMetrics.inCycle, false);
  assert.strictEqual(mainMetrics.smells, mainSmells);
  assert.deepEqual(updates, [other]);

  analyzer.recomputeAndBroadcast(null);
  assert.deepEqual(updates, [other], 'no repeated notification after the status settles');
});
