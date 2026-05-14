import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore } from '../health/score.js';
import { SCORE_MODEL_COMPONENTS } from '../health/scoreModel.js';
import type { HealthMetrics } from '../health/types.js';

type ScoreInput = Omit<HealthMetrics, 'score' | 'language'>;

const BASE_SCORE_INPUT: ScoreInput = {
  loc: 500,
  commentRatio: 0,
  cyclomaticMax: 0,
  cyclomaticTotal: 0,
  cognitiveMax: 0,
  cognitiveTotal: 0,
  maxNestingDepth: 0,
  halstead: { vocabulary: 0, length: 0, volume: 0, difficulty: 0, effort: 0 },
  maintainabilityIndex: 100,
  functionCount: 0,
  namedFunctionCount: 0,
  avgFunctionLength: 0,
  maxFunctionLength: 0,
  maxParamCount: 0,
  classCount: 0,
  callGraphDensity: 0,
  godFunctionRatio: 0,
  smells: [],
  smellCount: 0,
};

function scoreInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return { ...BASE_SCORE_INPUT, ...overrides };
}

test('score model weights still account for the full score', () => {
  const totalWeight = SCORE_MODEL_COMPONENTS.reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  assert.equal(Math.round(totalWeight * 100), 100);
});

test('computeScore preserves representative score outputs', () => {
  assert.equal(computeScore(scoreInput()), 99);

  assert.equal(
    computeScore(
      scoreInput({
        cognitiveMax: 10,
        cyclomaticMax: 10,
        maintainabilityIndex: 70,
        maxNestingDepth: 4,
        maxFunctionLength: 75,
        smellCount: 10,
        callGraphDensity: 0.6,
        fanOut: 10,
        fanIn: 20,
      }),
    ),
    78,
  );

  assert.equal(
    computeScore(
      scoreInput({
        loc: 1500,
        cognitiveMax: 30,
        cyclomaticMax: 25,
        maintainabilityIndex: 0,
        maxNestingDepth: 8,
        maxFunctionLength: 250,
        smellCount: 75,
        callGraphDensity: 1.5,
        fanOut: 30,
        fanIn: 50,
        inCycle: true,
      }),
    ),
    0,
  );
});
