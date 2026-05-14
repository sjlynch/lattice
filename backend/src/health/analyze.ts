// Main entry: parse a file with tree-sitter and compute its
// HealthMetrics. Returns a partial result without the cross-file
// fields (fanIn / fanOut / inCycle); crossFile.ts patches those in
// after the per-file pass for the whole project completes.

import type { HealthLanguage, HealthMetrics } from './types.js';
import { getParser, grammarKeyForExt, type GrammarKey } from './parser.js';
import { analyzeTree } from './walker.js';
import { computeHalstead, computeMaintainabilityIndex } from './halstead.js';
import { COMMENT_BY_EXT, countLineKinds } from './universal.js';
import { computeScore } from './score.js';
import { AST_MAX_BYTES } from './constants.js';
import { languageForExt } from './analyze/language.js';
import { analyzeFallback } from './analyze/fallback.js';
import { aggregateFunctionMetrics, computeCallGraph } from './analyze/functionMetrics.js';
import { assembleSmells } from './analyze/smells.js';

export type AnalyzeResult = {
  metrics: HealthMetrics;
  // Module specifiers as written in import statements. crossFile.ts
  // resolves these against the actual file tree.
  imports: string[];
};

export async function analyzeFile(
  content: string,
  ext: string,
  totalLoc: number,
): Promise<AnalyzeResult> {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const language = languageForExt(ext);

  if (language === 'fallback' || sizeBytes > AST_MAX_BYTES) {
    return analyzeFallback(content, ext, totalLoc);
  }

  const grammar = grammarKeyForExt(ext);
  if (!grammar) return analyzeFallback(content, ext, totalLoc);

  let parserHandle;
  try {
    parserHandle = await getParser(ext);
  } catch (err) {
    if (process.env.LATTICE_HEALTH_DEBUG) console.error('[health] getParser failed:', err);
    return analyzeFallback(content, ext, totalLoc);
  }
  if (!parserHandle) return analyzeFallback(content, ext, totalLoc);

  // The parser is pooled (see parser.ts) so we only need to clean up
  // the tree afterwards — the parser instance is reused across files.
  const { parser } = parserHandle;
  let tree;
  try {
    tree = parser.parse(content);
  } catch (err) {
    if (process.env.LATTICE_HEALTH_DEBUG) console.error('[health] parse failed:', err);
    return analyzeFallback(content, ext, totalLoc);
  }
  if (!tree) return analyzeFallback(content, ext, totalLoc);

  try {
    return computeFromTree(tree, content, ext, totalLoc, language, grammar);
  } finally {
    tree.delete();
  }
}

function computeFromTree(
  tree: import('web-tree-sitter').Tree,
  content: string,
  ext: string,
  totalLoc: number,
  language: HealthLanguage,
  grammar: GrammarKey,
): AnalyzeResult {
  const analysis = analyzeTree(tree, grammar, content);
  const aggregates = aggregateFunctionMetrics(analysis.functions, grammar);
  const callGraph = computeCallGraph(analysis.functions);

  const halstead = computeHalstead(tree);
  const avgCyclomatic =
    aggregates.functionCount > 0 ? aggregates.cyclomaticTotal / aggregates.functionCount : 0;
  const maintainabilityIndex = computeMaintainabilityIndex(
    halstead.volume,
    avgCyclomatic,
    Math.max(1, totalLoc),
  );

  const lineCounts = countLineKinds(content, COMMENT_BY_EXT[ext] ?? { line: ['//'] });
  const denom = lineCounts.code + lineCounts.comment;
  const commentRatio = denom > 0 ? lineCounts.comment / denom : 0;

  const { smells, smellCount } = assembleSmells({
    smellTokens: analysis.smellTokens,
    stringLiterals: analysis.stringLiterals,
    content,
    ext,
    totalLoc,
    aggregates,
    callGraph,
    maintainabilityIndex,
    classCount: analysis.classCount,
  });

  const components = {
    loc: totalLoc,
    commentRatio,
    cyclomaticMax: aggregates.cyclomaticMax,
    cyclomaticTotal: aggregates.cyclomaticTotal,
    cognitiveMax: aggregates.cognitiveMax,
    cognitiveTotal: aggregates.cognitiveTotal,
    maxNestingDepth: aggregates.maxNestingDepth,
    halstead,
    maintainabilityIndex,
    functionCount: aggregates.functionCount,
    namedFunctionCount: aggregates.namedFunctionCount,
    avgFunctionLength: aggregates.avgFunctionLength,
    maxFunctionLength: aggregates.maxFunctionLength,
    maxParamCount: aggregates.maxParamCount,
    classCount: analysis.classCount,
    callGraphDensity: callGraph.callGraphDensity,
    godFunctionRatio: callGraph.godFunctionRatio,
    smells,
    smellCount,
  };

  return {
    metrics: { ...components, score: computeScore(components), language },
    imports: analysis.imports,
  };
}
