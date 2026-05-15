// Serializable score component metadata shared with the frontend health legend.
// Keep this file data-only: backend scoring adds metric extractors in
// scoreModel.ts, while UI copy stays in frontend/components/legend.
// Weights are fractions of the 0-100 score this component can subtract;
// thresholds are the healthy boundary and full-penalty boundary.

export const SCORE_COMPONENT_METADATA = [
  {
    id: 'cognitive_complexity',
    weight: 0.20,
    healthyThreshold: 5,
    unhealthyThreshold: 30,
    higherIsWorse: true,
  },
  {
    id: 'cyclomatic_complexity',
    weight: 0.15,
    healthyThreshold: 5,
    unhealthyThreshold: 25,
    higherIsWorse: true,
  },
  {
    id: 'maintainability_index',
    weight: 0.12,
    healthyThreshold: 85,
    unhealthyThreshold: 0,
    higherIsWorse: false,
  },
  {
    id: 'nesting_depth',
    weight: 0.10,
    healthyThreshold: 2,
    unhealthyThreshold: 8,
    higherIsWorse: true,
  },
  {
    id: 'function_length',
    weight: 0.08,
    healthyThreshold: 30,
    unhealthyThreshold: 250,
    higherIsWorse: true,
  },
  {
    id: 'smell_density',
    weight: 0.10,
    healthyThreshold: 0,
    unhealthyThreshold: 0.05,
    higherIsWorse: true,
  },
  {
    id: 'call_graph_density',
    weight: 0.05,
    healthyThreshold: 0.3,
    unhealthyThreshold: 1.5,
    higherIsWorse: true,
  },
  {
    id: 'file_size',
    weight: 0.05,
    healthyThreshold: 200,
    unhealthyThreshold: 1500,
    higherIsWorse: true,
  },
  {
    id: 'fan_out',
    weight: 0.05,
    healthyThreshold: 8,
    unhealthyThreshold: 30,
    higherIsWorse: true,
  },
  {
    id: 'fan_in',
    weight: 0.05,
    healthyThreshold: 15,
    unhealthyThreshold: 50,
    higherIsWorse: true,
  },
  {
    id: 'circular_dependency',
    weight: 0.05,
    healthyThreshold: 0,
    unhealthyThreshold: 1,
    higherIsWorse: true,
  },
] as const;

export type ScoreComponentMetadata = (typeof SCORE_COMPONENT_METADATA)[number];
export type ScoreComponentId = ScoreComponentMetadata['id'];
