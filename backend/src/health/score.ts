// Composite 0–100 health score. Higher = healthier.
//
// Re-tuned from the v1 scorer:
//   - Cognitive complexity replaces cyclomatic as the primary signal
//     (Sonar's empirical evidence: cognitive correlates better with
//     "is this function hard to read" than McCabe's path count).
//   - Maintainability Index folded in directly (already a composite,
//     gives the score academic grounding).
//   - Smell density (now richer) keeps a meaningful slice.
//   - Cross-file penalties only apply when fanIn/fanOut/inCycle are
//     populated — files we couldn't analyze cross-file aren't blamed
//     for missing data.

import { TINY_FILE_LOC_THRESHOLD } from './types.js';
import { clamp01 } from './scoreMath.js';
import {
  SCORE_MODEL_COMPONENTS,
  scoreComponentLoss,
  type ScoreInput,
} from './scoreModel.js';

export function computeScore(m: ScoreInput): number {
  // Tiny files always score 100; they can't reasonably be measured.
  if (m.loc > 0 && m.loc < TINY_FILE_LOC_THRESHOLD) return 100;

  const lost = SCORE_MODEL_COMPONENTS.reduce(
    (sum, component) => sum + component.weight * scoreComponentLoss(component, m),
    0,
  );

  const score = (1 - clamp01(lost)) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}
