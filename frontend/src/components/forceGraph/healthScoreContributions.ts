import type { HealthMetrics } from '../../api';
import {
  SCORE_COMPONENT_METADATA,
  type ScoreComponentId,
  type ScoreComponentMetadata,
} from '../../../../backend/src/health/scoreMetadata';

export type ScoreContributionSeverity = 'none' | 'low' | 'medium' | 'high';

export type HealthScoreContribution = {
  componentId: ScoreComponentId;
  pointsLost: number;
  maxPoints: number;
  lossRatio: number;
  severity: ScoreContributionSeverity;
};

const SCORE_POINTS = 100;
const POINTS_DISPLAY_EPSILON = 0.05;
const LOSS_RATIO_EPSILON = 0.05;

const SCORE_COMPONENT_VALUES: Record<
  ScoreComponentId,
  (metrics: HealthMetrics) => number | null | undefined
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

export function buildHealthScoreContributions(
  metrics: HealthMetrics,
): Record<ScoreComponentId, HealthScoreContribution> {
  const tinyFileBypass = metrics.loc > 0 && metrics.loc < 30;

  return Object.fromEntries(
    SCORE_COMPONENT_METADATA.map((component) => {
      const maxPoints = component.weight * SCORE_POINTS;
      const lossRatio = tinyFileBypass ? 0 : scoreComponentLossRatio(component, metrics);
      const pointsLost = maxPoints * lossRatio;
      return [
        component.id,
        {
          componentId: component.id,
          pointsLost,
          maxPoints,
          lossRatio,
          severity: contributionSeverity(lossRatio),
        },
      ];
    }),
  ) as Record<ScoreComponentId, HealthScoreContribution>;
}

export function formatPointsLost(contribution: HealthScoreContribution): string {
  const pointsLost = contribution.pointsLost;
  if (!Number.isFinite(pointsLost) || pointsLost <= POINTS_DISPLAY_EPSILON) return '(0)';
  if (pointsLost < 1) return `(-${pointsLost.toFixed(1)})`;
  return `(-${Math.round(pointsLost)})`;
}

function scoreComponentLossRatio(
  component: ScoreComponentMetadata,
  metrics: HealthMetrics,
): number {
  const value = SCORE_COMPONENT_VALUES[component.id](metrics);
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

function contributionSeverity(lossRatio: number): ScoreContributionSeverity {
  if (lossRatio <= LOSS_RATIO_EPSILON) return 'none';
  if (lossRatio < 1 / 3) return 'low';
  if (lossRatio < 2 / 3) return 'medium';
  return 'high';
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
