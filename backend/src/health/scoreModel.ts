import type { HealthMetrics } from './types.js';
import { norm } from './scoreMath.js';
import {
  SCORE_COMPONENT_METADATA,
  type ScoreComponentId,
  type ScoreComponentMetadata,
} from './scoreMetadata.js';

export type ScoreInput = Omit<HealthMetrics, 'score' | 'language'>;
export type { ScoreComponentId, ScoreComponentMetadata };

export type ScoreModelComponent = ScoreComponentMetadata & {
  value: (metrics: ScoreInput) => number | null | undefined;
};

const SCORE_COMPONENT_VALUES: Record<
  ScoreComponentId,
  (metrics: ScoreInput) => number | null | undefined
> = {
  cognitive_complexity: (m) => m.cognitiveMax,
  cyclomatic_complexity: (m) => m.cyclomaticMax,
  maintainability_index: (m) => m.maintainabilityIndex,
  nesting_depth: (m) => m.maxNestingDepth,
  function_length: (m) => m.maxFunctionLength,
  smell_density: (m) => (m.loc > 0 ? m.smellCount / m.loc : 0),
  call_graph_density: (m) => m.callGraphDensity,
  file_size: (m) => m.loc,
  fan_out: (m) => m.fanOut,
  fan_in: (m) => m.fanIn,
  circular_dependency: (m) => (m.inCycle ? 1 : 0),
};

export const SCORE_MODEL_COMPONENTS: readonly ScoreModelComponent[] =
  SCORE_COMPONENT_METADATA.map((component) => ({
    ...component,
    value: SCORE_COMPONENT_VALUES[component.id],
  }));

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
