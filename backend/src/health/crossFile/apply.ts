import { computeScore } from '../score.js';
import type { HealthMetrics } from '../types.js';
import { bump, type SmellCounter } from '../universal.js';
import { smellsToArray } from '../utils.js';
import type { CrossFileResult } from './graph.js';

// Merge cross-file results into per-file HealthMetrics in place. Adds the
// relevant smells and recomputes the composite score.
export function applyCrossFile(
  metrics: Map<string, HealthMetrics>,
  cross: CrossFileResult,
): void {
  for (const [filePath, m] of metrics) {
    m.fanIn = cross.fanIn.get(filePath) ?? 0;
    m.fanOut = cross.fanOut.get(filePath) ?? 0;
    m.inCycle = cross.inCycle.has(filePath);

    // Patch the smells list to reflect cross-file findings.
    const smellMap: SmellCounter = new Map();
    for (const s of m.smells) {
      smellMap.set(s.id, s.count);
    }
    if (m.inCycle) bump(smellMap, 'circular_dependency');
    if (m.fanOut > 25) bump(smellMap, 'high_fan_out');
    if (m.fanIn > 30) bump(smellMap, 'high_fan_in');

    // Rebuild smells array in the same shape `analyze.ts` produced.
    const out = smellsToArray(smellMap);
    m.smells = out;
    let total = 0;
    for (const s of out) total += s.count;
    m.smellCount = total;

    // Recompute the score with the cross-file fields in play.
    m.score = computeScore(m);
  }
}
