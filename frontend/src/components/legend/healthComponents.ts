// Static breakdown of the code health score. Shown in place of the
// regular extensions legend while the user holds `h` in the graph view.
// Per-file scores live in the on-graph hover tooltip; this panel only
// describes what the score means and how it's weighted.
//
// Score ids, order, weights, thresholds, and direction come from the
// backend's serializable score metadata so the legend cannot drift from
// computeScore. UI labels/detail copy live in `healthComponentCopy.ts`,
// and this module just maps that copy onto the metadata.

import {
  SCORE_COMPONENT_METADATA,
  type ScoreComponentId,
} from '../../../../backend/src/health/scoreMetadata';
import { HEALTH_COMPONENT_COPY, type DetailEntry } from './healthComponentCopy';

export type HealthComponentId = ScoreComponentId;

// Structured tooltip detail. Rendering puts the bolded label on its
// own line followed by the body text, so users get a readable list
// rather than a wall of prose.
export type { DetailEntry };

export type HealthComponent = {
  id: HealthComponentId;
  label: string;
  weight: number;
  healthyThreshold: number;
  unhealthyThreshold: number;
  higherIsWorse: boolean;
  note: string;
  detail: DetailEntry[];
};

export const HEALTH_COMPONENTS: HealthComponent[] = SCORE_COMPONENT_METADATA.map(
  (component) => ({
    ...component,
    ...HEALTH_COMPONENT_COPY[component.id],
    weight: Math.round(component.weight * 100),
  }),
);
