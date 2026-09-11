import { computeScore } from '../score.js';
import type { HealthMetrics, HealthSmellId } from '../types.js';
import type { SmellCounter } from '../universal.js';
import { smellsToArray } from '../utils.js';
import type { CrossFileResult } from './graph.js';

const CROSS_FILE_SMELLS = new Set<HealthSmellId>([
  'circular_dependency',
  'high_fan_out',
  'high_fan_in',
]);

// Cached metrics already contain fan fields and may contain inflated or stale
// smells from an older backend. Normalize every metrics object once before it
// can take the unchanged fast path. The weak keys do not retain removed files,
// and hydration/reanalysis creates new objects that must be normalized again.
const appliedMetrics = new WeakSet<HealthMetrics>();

// Replace the derived cross-file smells in per-file HealthMetrics in place,
// preserving per-file findings and recomputing the composite score.
export function applyCrossFile(
  metrics: Map<string, HealthMetrics>,
  cross: CrossFileResult,
): void {
  for (const [filePath, m] of metrics) {
    const newFanIn = cross.fanIn.get(filePath) ?? 0;
    const newFanOut = cross.fanOut.get(filePath) ?? 0;
    const newInCycle = cross.inCycle.has(filePath);
    // Reachability classification (only present when the pass was given a root
    // set). Intentionally NOT fed into computeScore below — dead status is a
    // separate signal, not a maintainability penalty.
    const dc = cross.deadCode.get(filePath);

    // A single-file edit leaves most files' inputs unchanged. After their first
    // normalization, preserve the smells array and skip sorting/scoring for
    // those files. Derived smell counts also feed the score's smell density,
    // so unchanged fan fields alone cannot justify trusting a hydrated cache.
    const unchanged =
      m.fanIn !== undefined && m.fanIn === newFanIn &&
      m.fanOut !== undefined && m.fanOut === newFanOut &&
      m.inCycle !== undefined && m.inCycle === newInCycle &&
      m.deadCode === (dc ?? m.deadCode);

    m.fanIn = newFanIn;
    m.fanOut = newFanOut;
    m.inCycle = newInCycle;
    if (dc) m.deadCode = dc;

    if (unchanged && appliedMetrics.has(m)) continue;

    // These three smells are boolean findings of the current graph, not event
    // counters. Remove their previous values before applying this result so
    // resolved warnings disappear and repeated recomputations cannot inflate
    // counts. Other smells still belong to the per-file analyzer.
    const smellMap: SmellCounter = new Map();
    for (const s of m.smells) {
      if (!CROSS_FILE_SMELLS.has(s.id)) smellMap.set(s.id, s.count);
    }
    if (m.inCycle) smellMap.set('circular_dependency', 1);
    if (m.fanOut > 25) smellMap.set('high_fan_out', 1);
    if (m.fanIn > 30) smellMap.set('high_fan_in', 1);

    // Rebuild smells array in the same shape `analyze.ts` produced.
    const out = smellsToArray(smellMap);
    m.smells = out;
    let total = 0;
    for (const s of out) total += s.count;
    m.smellCount = total;

    // Recompute the score with the cross-file fields in play.
    m.score = computeScore(m);
    appliedMetrics.add(m);
  }
}
