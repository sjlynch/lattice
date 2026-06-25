// Shared health-metric fixtures for the split health suites. Not a `*.test.ts`
// file, so it isn't collected as a suite — just imported by the ones that need it.

import type { HealthMetrics } from '../../health/index.js';

export function smellCount(metrics: HealthMetrics, id: string): number {
  return metrics.smells.find((s) => s.id === id)?.count ?? 0;
}

export function minimalMetrics(overrides: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    score: 100,
    language: 'typescript',
    loc: 1,
    commentRatio: 0,
    cyclomaticMax: 1,
    cyclomaticTotal: 1,
    cognitiveMax: 0,
    cognitiveTotal: 0,
    maxNestingDepth: 0,
    halstead: {
      vocabulary: 0,
      length: 0,
      volume: 0,
      difficulty: 0,
      effort: 0,
    },
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
    ...overrides,
  };
}
