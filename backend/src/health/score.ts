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

import type { HealthMetrics } from './types.js';
import { TINY_FILE_LOC_THRESHOLD } from './types.js';

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

type ScoreInput = Omit<HealthMetrics, 'score' | 'language'>;

export function computeScore(m: ScoreInput): number {
  // Tiny files always score 100; they can't reasonably be measured.
  if (m.loc > 0 && m.loc < TINY_FILE_LOC_THRESHOLD) return 100;

  const smellDensity = m.loc > 0 ? m.smellCount / m.loc : 0;
  // Map MI (0–100, higher=better) to a 0–1 "lost" contribution.
  // MI ≥ 85 → 0 lost. MI = 0 → 0.4 lost (full weight).
  const miLost = clamp01((85 - m.maintainabilityIndex) / 85);
  // Cross-file penalties only kick in when we have the data.
  const fanOutLost = m.fanOut == null ? 0 : norm(m.fanOut, 8, 30);
  const fanInLost = m.fanIn == null ? 0 : norm(m.fanIn, 15, 50);
  const cycleLost = m.inCycle ? 1 : 0;

  const lost =
    0.20 * norm(m.cognitiveMax, 5, 30) +
    0.15 * norm(m.cyclomaticMax, 5, 25) +
    0.12 * miLost +
    0.10 * norm(m.maxNestingDepth, 2, 8) +
    0.08 * norm(m.maxFunctionLength, 30, 250) +
    0.10 * norm(smellDensity, 0, 0.05) +
    0.05 * norm(m.callGraphDensity, 0.3, 1.5) +
    0.05 * norm(m.loc, 200, 1500) +
    0.05 * fanOutLost +
    0.05 * fanInLost +
    0.05 * cycleLost;

  const score = (1 - clamp01(lost)) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}
