import type { HealthSmell, HealthSmellId } from '../types.js';
import type { FileAnalysis } from '../walker.js';
import {
  COMMENT_BY_EXT,
  countUniversalSmells,
  bump,
  type SmellCounter,
} from '../universal.js';
import {
  LARGE_FILE_LOC_THRESHOLD,
  HIGH_FUNCTION_COUNT,
  HIGH_COMPLEXITY_THRESHOLD,
  DEEP_NESTING_THRESHOLD,
  LONG_FUNCTION_LOC,
  LONG_PARAM_LIST,
  LOW_MAINTAINABILITY_MI,
  MAGIC_STRING_MIN_OCCURRENCES,
} from '../constants.js';
import { smellsToArray } from '../utils.js';
import type { FunctionMetricAggregates, CallGraphMetrics } from './functionMetrics.js';

export type AssembleSmellsInput = {
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

type SmellTokenKey = keyof FileAnalysis['smellTokens'];

type TokenSmellRule = {
  key: SmellTokenKey;
  id: HealthSmellId;
  transform?: (count: number) => number;
};

// Keep this in the same order the old if-chain inserted into the Map so
// `smellsToArray` remains stable for equal-count smells.
const TOKEN_SMELL_RULES: readonly TokenSmellRule[] = [
  { key: 'anyType', id: 'any_type' },
  { key: 'typeAssertion', id: 'type_assertion' },
  { key: 'nonNullAssertion', id: 'non_null_assertion' },
  { key: 'debuggerStmt', id: 'debugger_stmt' },
  { key: 'consoleCalls', id: 'console_log' },
  { key: 'evalCalls', id: 'eval_call' },
  { key: 'varDecls', id: 'var_keyword' },
  { key: 'looseEquality', id: 'loose_equality' },
  { key: 'emptyCatch', id: 'empty_catch' },
  { key: 'deepOptionalChain', id: 'deep_optional_chain' },
  { key: 'deepTernary', id: 'deep_ternary' },
  { key: 'emptyInterface', id: 'empty_interface' },
  { key: 'printCalls', id: 'print_call' },
  { key: 'bareExcept', id: 'bare_except' },
  { key: 'wildcardImport', id: 'wildcard_import' },
  { key: 'mutableDefaultArg', id: 'mutable_default_arg' },
  { key: 'globalKeyword', id: 'global_keyword' },
  { key: 'tsIgnore', id: 'ts_ignore' },
  { key: 'eslintDisable', id: 'eslint_disable' },
  { key: 'mixedExports', id: 'mixed_exports' },
];

function foldTokenSmells(
  smells: SmellCounter,
  tokens: FileAnalysis['smellTokens'],
): void {
  for (const rule of TOKEN_SMELL_RULES) {
    const raw = tokens[rule.key];
    const count = rule.transform ? rule.transform(raw) : raw;
    if (count > 0) bump(smells, rule.id, count);
  }
}

export function assembleSmells({
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
  foldTokenSmells(smells, smellTokens);

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
