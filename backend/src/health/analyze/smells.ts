import type { HealthSmell } from '../types.js';
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
