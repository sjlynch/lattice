import type { HealthMetrics } from '../types.js';
import { computeScore } from '../score.js';
import { COMMENT_BY_EXT, countLineKinds, countUniversalSmells, bump } from '../universal.js';
import { LARGE_FILE_LOC_THRESHOLD } from '../constants.js';
import { smellsToArray } from '../utils.js';
import type { AnalyzeResult } from '../analyze.js';

type StaticMetricDefaults = Omit<
  HealthMetrics,
  | 'score'
  | 'language'
  | 'loc'
  | 'commentRatio'
  | 'fanIn'
  | 'fanOut'
  | 'inCycle'
  | 'smells'
  | 'smellCount'
>;

export const DEFAULT_METRICS: StaticMetricDefaults = {
  cyclomaticMax: 0,
  cyclomaticTotal: 0,
  cognitiveMax: 0,
  cognitiveTotal: 0,
  maxNestingDepth: 0,
  halstead: { vocabulary: 0, length: 0, volume: 0, difficulty: 0, effort: 0 },
  maintainabilityIndex: 100,
  functionCount: 0,
  namedFunctionCount: 0,
  avgFunctionLength: 0,
  maxFunctionLength: 0,
  maxParamCount: 0,
  classCount: 0,
  callGraphDensity: 0,
  godFunctionRatio: 0,
};

// Fallback path for unsupported languages OR files too big for AST
// analysis. Returns LOC + universal smells only.
export function analyzeFallback(
  content: string,
  ext: string,
  totalLoc: number,
): AnalyzeResult {
  const syntax = COMMENT_BY_EXT[ext] ?? { line: ['//'], blockOpen: '/*', blockClose: '*/' };
  const lineCounts = countLineKinds(content, syntax);
  const denom = lineCounts.code + lineCounts.comment;
  const commentRatio = denom > 0 ? lineCounts.comment / denom : 0;

  const smells = countUniversalSmells(content, syntax);
  if (totalLoc > LARGE_FILE_LOC_THRESHOLD) bump(smells, 'large_file');
  const smellList = smellsToArray(smells);
  let smellCount = 0;
  for (const s of smellList) smellCount += s.count;

  const components = {
    ...DEFAULT_METRICS,
    halstead: { ...DEFAULT_METRICS.halstead },
    loc: totalLoc,
    commentRatio,
    smells: smellList,
    smellCount,
  };

  return {
    metrics: { ...components, score: computeScore(components), language: 'fallback' },
    imports: [],
  };
}
