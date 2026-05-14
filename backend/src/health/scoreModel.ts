import type { HealthMetrics } from './types.js';

export type ScoreInput = Omit<HealthMetrics, 'score' | 'language'>;

export type ScoreComponentId =
  | 'cognitive_complexity'
  | 'cyclomatic_complexity'
  | 'maintainability_index'
  | 'nesting_depth'
  | 'function_length'
  | 'smell_density'
  | 'call_graph_density'
  | 'file_size'
  | 'fan_out'
  | 'fan_in'
  | 'circular_dependency';

export type ScoreModelComponent = {
  id: ScoreComponentId;
  // Fraction of the 0-100 score this component can subtract.
  weight: number;
  // Boundary where this component starts losing points.
  healthyThreshold: number;
  // Boundary where this component has lost its full weight.
  unhealthyThreshold: number;
  higherIsWorse: boolean;
  value: (metrics: ScoreInput) => number | null | undefined;
};

export const SCORE_MODEL_COMPONENTS: readonly ScoreModelComponent[] = [
  {
    id: 'cognitive_complexity',
    weight: 0.20,
    healthyThreshold: 5,
    unhealthyThreshold: 30,
    higherIsWorse: true,
    value: (m) => m.cognitiveMax,
  },
  {
    id: 'cyclomatic_complexity',
    weight: 0.15,
    healthyThreshold: 5,
    unhealthyThreshold: 25,
    higherIsWorse: true,
    value: (m) => m.cyclomaticMax,
  },
  {
    id: 'maintainability_index',
    weight: 0.12,
    healthyThreshold: 85,
    unhealthyThreshold: 0,
    higherIsWorse: false,
    value: (m) => m.maintainabilityIndex,
  },
  {
    id: 'nesting_depth',
    weight: 0.10,
    healthyThreshold: 2,
    unhealthyThreshold: 8,
    higherIsWorse: true,
    value: (m) => m.maxNestingDepth,
  },
  {
    id: 'function_length',
    weight: 0.08,
    healthyThreshold: 30,
    unhealthyThreshold: 250,
    higherIsWorse: true,
    value: (m) => m.maxFunctionLength,
  },
  {
    id: 'smell_density',
    weight: 0.10,
    healthyThreshold: 0,
    unhealthyThreshold: 0.05,
    higherIsWorse: true,
    value: (m) => (m.loc > 0 ? m.smellCount / m.loc : 0),
  },
  {
    id: 'call_graph_density',
    weight: 0.05,
    healthyThreshold: 0.3,
    unhealthyThreshold: 1.5,
    higherIsWorse: true,
    value: (m) => m.callGraphDensity,
  },
  {
    id: 'file_size',
    weight: 0.05,
    healthyThreshold: 200,
    unhealthyThreshold: 1500,
    higherIsWorse: true,
    value: (m) => m.loc,
  },
  {
    id: 'fan_out',
    weight: 0.05,
    healthyThreshold: 8,
    unhealthyThreshold: 30,
    higherIsWorse: true,
    value: (m) => m.fanOut,
  },
  {
    id: 'fan_in',
    weight: 0.05,
    healthyThreshold: 15,
    unhealthyThreshold: 50,
    higherIsWorse: true,
    value: (m) => m.fanIn,
  },
  {
    id: 'circular_dependency',
    weight: 0.05,
    healthyThreshold: 0,
    unhealthyThreshold: 1,
    higherIsWorse: true,
    value: (m) => (m.inCycle ? 1 : 0),
  },
];

export function scoreComponentLoss(
  component: ScoreModelComponent,
  metrics: ScoreInput,
): number {
  const value = component.value(metrics);
  if (value == null) return 0;
  if (component.higherIsWorse) {
    return norm(value, component.healthyThreshold, component.unhealthyThreshold);
  }
  return norm(
    component.healthyThreshold - value,
    0,
    component.healthyThreshold - component.unhealthyThreshold,
  );
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function norm(x: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  return clamp01((x - lo) / (hi - lo));
}
