// Main entry: parse a file with tree-sitter and compute its
// HealthMetrics. Returns a partial result without the cross-file
// fields (fanIn / fanOut / inCycle); crossFile.ts patches those in
// after the per-file pass for the whole project completes.

import type { HealthLanguage, HealthMetrics, HealthSmell } from './types.js';
import { getParser, grammarKeyForExt, type GrammarKey } from './parser.js';
import { analyzeTree, type FileAnalysis, type FnRecord } from './walker.js';
import { computeHalstead, computeMaintainabilityIndex } from './halstead.js';
import {
  COMMENT_BY_EXT,
  countLineKinds,
  countUniversalSmells,
  bump,
  type SmellCounter,
} from './universal.js';
import { computeScore } from './score.js';
import {
  AST_MAX_BYTES,
  LARGE_FILE_LOC_THRESHOLD,
  HIGH_FUNCTION_COUNT,
  HIGH_COMPLEXITY_THRESHOLD,
  DEEP_NESTING_THRESHOLD,
  LONG_FUNCTION_LOC,
  LONG_PARAM_LIST,
  LOW_MAINTAINABILITY_MI,
  MAGIC_STRING_MIN_OCCURRENCES,
  GOD_FUNCTION_MIN_OTHERS,
  GOD_FUNCTION_CALL_FRACTION,
} from './constants.js';
import { smellsToArray } from './utils.js';

const LANGUAGE_BY_EXT: Record<string, HealthLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.rb': 'ruby',
};

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

const DEFAULT_METRICS: StaticMetricDefaults = {
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

function languageForExt(ext: string): HealthLanguage {
  return LANGUAGE_BY_EXT[ext] ?? 'fallback';
}

export type AnalyzeResult = {
  metrics: HealthMetrics;
  // Module specifiers as written in import statements. crossFile.ts
  // resolves these against the actual file tree.
  imports: string[];
};

// Fallback path for unsupported languages OR files too big for AST
// analysis. Returns LOC + universal smells only.
function analyzeFallback(content: string, ext: string, totalLoc: number): AnalyzeResult {
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

type FunctionMetricAggregates = {
  functionCount: number;
  cyclomaticMax: number;
  cyclomaticTotal: number;
  cognitiveMax: number;
  cognitiveTotal: number;
  maxNestingDepth: number;
  namedFunctionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  maxParamCount: number;
  booleanParamCount: number;
  mixedSyncAsyncCount: number;
  missingDocstringCount: number;
};

type CallGraphMetrics = {
  callGraphDensity: number;
  godFunctionRatio: number;
  godFunctionCount: number;
};

type AssembleSmellsInput = {
  smellTokens: FileAnalysis['smellTokens'];
  stringLiterals: FileAnalysis['stringLiterals'];
  content: string;
  ext: string;
  totalLoc: number;
  aggregates: FunctionMetricAggregates;
  callGraph: CallGraphMetrics;
  maintainabilityIndex: number;
  classCount: number;
};

function aggregateFunctionMetrics(
  functions: FnRecord[],
  grammar: GrammarKey,
): FunctionMetricAggregates {
  let cyclomaticMax = 0;
  let cyclomaticTotal = 0;
  let cognitiveMax = 0;
  let cognitiveTotal = 0;
  let maxFunctionLength = 0;
  let functionLengthTotal = 0;
  let maxParamCount = 0;
  let maxNestingDepth = 0;
  let booleanParamCount = 0;
  let mixedSyncAsyncCount = 0;
  let missingDocstringCount = 0;
  let namedFunctionCount = 0;

  for (const fn of functions) {
    if (!fn.isAnonymous) namedFunctionCount++;
    if (fn.cyclomatic > cyclomaticMax) cyclomaticMax = fn.cyclomatic;
    cyclomaticTotal += fn.cyclomatic;
    if (fn.cognitive > cognitiveMax) cognitiveMax = fn.cognitive;
    cognitiveTotal += fn.cognitive;
    // Use ownLines for the "function length" metric — see walker.ts.
    const len = Math.max(1, fn.ownLines);
    if (len > maxFunctionLength) maxFunctionLength = len;
    functionLengthTotal += len;
    if (fn.paramCount > maxParamCount) maxParamCount = fn.paramCount;
    if (fn.maxNestingDepth > maxNestingDepth) {
      maxNestingDepth = fn.maxNestingDepth;
    }
    booleanParamCount += fn.booleanParamCount;
    if (fn.isAsync && !fn.hasAwait) mixedSyncAsyncCount++;
    if (
      grammar === 'python' &&
      !fn.hasDocstring &&
      fn.name &&
      !fn.name.startsWith('_')
    ) {
      missingDocstringCount++;
    }
  }

  const functionCount = functions.length;
  return {
    functionCount,
    cyclomaticMax,
    cyclomaticTotal,
    cognitiveMax,
    cognitiveTotal,
    maxNestingDepth,
    namedFunctionCount,
    avgFunctionLength: functionCount > 0 ? functionLengthTotal / functionCount : 0,
    maxFunctionLength,
    maxParamCount,
    booleanParamCount,
    mixedSyncAsyncCount,
    missingDocstringCount,
  };
}

function computeCallGraph(functions: FnRecord[]): CallGraphMetrics {
  // For each function, count how many of its calls resolve to another
  // function defined in this file. Sum / functionCount = density.
  // Range: 0 (functions don't call each other) to ~1 (each function
  // calls every other function — god-function pattern).
  const fnNamesInFile = new Set<string>();
  for (const fn of functions) {
    if (fn.name) fnNamesInFile.add(fn.name);
  }

  let internalCallTotal = 0;
  let godFunctionCount = 0;
  for (const fn of functions) {
    let internal = 0;
    for (const c of fn.calls) {
      if (fnNamesInFile.has(c)) internal++;
    }
    internalCallTotal += internal;

    // "god function" heuristic: calls a configured share of other
    // functions, once the file has enough other functions to compare.
    const others = fnNamesInFile.size - (fn.name ? 1 : 0);
    const godFunctionCallThreshold = Math.max(
      GOD_FUNCTION_MIN_OTHERS,
      Math.floor(others * GOD_FUNCTION_CALL_FRACTION),
    );
    if (others >= GOD_FUNCTION_MIN_OTHERS && internal >= godFunctionCallThreshold) {
      godFunctionCount++;
    }
  }

  const functionCount = functions.length;
  return {
    callGraphDensity: functionCount > 0 ? internalCallTotal / functionCount : 0,
    godFunctionRatio: functionCount > 0 ? godFunctionCount / functionCount : 0,
    godFunctionCount,
  };
}

function assembleSmells({
  smellTokens,
  stringLiterals,
  content,
  ext,
  totalLoc,
  aggregates,
  callGraph,
  maintainabilityIndex,
  classCount,
}: AssembleSmellsInput): { smells: HealthSmell[]; smellCount: number } {
  const smells: SmellCounter = new Map();
  const t = smellTokens;
  if (t.anyType) bump(smells, 'any_type', t.anyType);
  if (t.typeAssertion) bump(smells, 'type_assertion', t.typeAssertion);
  if (t.nonNullAssertion) bump(smells, 'non_null_assertion', t.nonNullAssertion);
  if (t.debuggerStmt) bump(smells, 'debugger_stmt', t.debuggerStmt);
  if (t.consoleCalls) bump(smells, 'console_log', t.consoleCalls);
  if (t.evalCalls) bump(smells, 'eval_call', t.evalCalls);
  if (t.varDecls) bump(smells, 'var_keyword', t.varDecls);
  if (t.looseEquality) bump(smells, 'loose_equality', t.looseEquality);
  if (t.emptyCatch) bump(smells, 'empty_catch', t.emptyCatch);
  if (t.deepOptionalChain) bump(smells, 'deep_optional_chain', t.deepOptionalChain);
  if (t.deepTernary) bump(smells, 'deep_ternary', t.deepTernary);
  if (t.emptyInterface) bump(smells, 'empty_interface', t.emptyInterface);
  if (t.printCalls) bump(smells, 'print_call', t.printCalls);
  if (t.bareExcept) bump(smells, 'bare_except', t.bareExcept);
  if (t.wildcardImport) bump(smells, 'wildcard_import', t.wildcardImport);
  if (t.mutableDefaultArg) bump(smells, 'mutable_default_arg', t.mutableDefaultArg);
  if (t.globalKeyword) bump(smells, 'global_keyword', t.globalKeyword);
  if (t.tsIgnore) bump(smells, 'ts_ignore', t.tsIgnore);
  if (t.eslintDisable) bump(smells, 'eslint_disable', t.eslintDisable);
  if (t.mixedExports) bump(smells, 'mixed_exports', t.mixedExports);

  if (aggregates.booleanParamCount > 0) {
    bump(smells, 'boolean_param', aggregates.booleanParamCount);
  }
  if (aggregates.mixedSyncAsyncCount > 0) {
    bump(smells, 'mixed_sync_async', aggregates.mixedSyncAsyncCount);
  }
  if (aggregates.missingDocstringCount > 0) {
    bump(smells, 'missing_docstring', aggregates.missingDocstringCount);
  }

  // Magic strings: literals repeated at least MAGIC_STRING_MIN_OCCURRENCES times.
  let magicStrings = 0;
  for (const count of stringLiterals.values()) {
    if (count >= MAGIC_STRING_MIN_OCCURRENCES) magicStrings++;
  }
  if (magicStrings > 0) bump(smells, 'magic_string', magicStrings);

  // Universal regex-driven smells (TODO/FIXME, magic numbers,
  // long string literals, commented-out code).
  const universal = countUniversalSmells(
    content,
    COMMENT_BY_EXT[ext] ?? { line: ['//'] },
  );
  for (const [id, count] of universal) bump(smells, id, count);

  // Aggregate-derived smells (size thresholds).
  if (totalLoc > LARGE_FILE_LOC_THRESHOLD) bump(smells, 'large_file');
  if (aggregates.namedFunctionCount > HIGH_FUNCTION_COUNT) {
    bump(smells, 'high_function_count');
  }
  if (classCount > 1) {
    bump(smells, 'multiple_classes', classCount - 1);
  }
  if (aggregates.cyclomaticMax > HIGH_COMPLEXITY_THRESHOLD) {
    bump(smells, 'high_complexity');
  }
  if (aggregates.cognitiveMax > HIGH_COMPLEXITY_THRESHOLD) {
    bump(smells, 'high_cognitive_complexity');
  }
  if (aggregates.maxNestingDepth > DEEP_NESTING_THRESHOLD) {
    bump(smells, 'deep_nesting');
  }
  if (aggregates.maxFunctionLength > LONG_FUNCTION_LOC) bump(smells, 'long_function');
  if (aggregates.maxParamCount > LONG_PARAM_LIST) bump(smells, 'long_param_list');
  if (maintainabilityIndex < LOW_MAINTAINABILITY_MI) {
    bump(smells, 'low_maintainability');
  }
  if (callGraph.godFunctionCount > 0) {
    bump(smells, 'god_function', callGraph.godFunctionCount);
  }

  const smellList = smellsToArray(smells);
  let smellCount = 0;
  for (const s of smellList) smellCount += s.count;
  return { smells: smellList, smellCount };
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
