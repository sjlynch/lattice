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
    const newFanIn = cross.fanIn.get(filePath) ?? 0;
    const newFanOut = cross.fanOut.get(filePath) ?? 0;
    const newInCycle = cross.inCycle.has(filePath);
    // Reachability classification (only present when the pass was given a root
    // set). Intentionally NOT fed into computeScore below — dead status is a
    // separate signal, not a maintainability penalty.
    const dc = cross.deadCode.get(filePath);

    // Skip the smell-rebuild + computeScore when none of the cross-file inputs
    // changed. A single-file edit leaves the vast majority of files with
    // identical fanIn/fanOut/inCycle, and those three (plus deadCode) are the
    // ONLY cross-file signals — the circular_dependency / high_fan_out /
    // high_fan_in smells and the score (which reads fanIn/fanOut/inCycle
    // directly, never the smell counts) are then bit-for-bit unchanged.
    // Gate on the previous values being DEFINED so the first pass after a fresh
    // (cache-hydrated, fan* still undefined) boot — and the just-reanalyzed
    // originator (its metrics carry no cross-file fields yet) — still rebuild.
    const unchanged =
      m.fanIn !== undefined && m.fanIn === newFanIn &&
      m.fanOut !== undefined && m.fanOut === newFanOut &&
      m.inCycle !== undefined && m.inCycle === newInCycle &&
      m.deadCode === (dc ?? m.deadCode);

    m.fanIn = newFanIn;
    m.fanOut = newFanOut;
    m.inCycle = newInCycle;
    if (dc) m.deadCode = dc;

    if (unchanged) continue;

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
