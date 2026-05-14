import type { FnRecord } from '../walker.js';
import type { GrammarKey } from '../parser.js';
import { GOD_FUNCTION_MIN_OTHERS, GOD_FUNCTION_CALL_FRACTION } from '../constants.js';

export type FunctionMetricAggregates = {
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

export type CallGraphMetrics = {
  callGraphDensity: number;
  godFunctionRatio: number;
  godFunctionCount: number;
};

export function aggregateFunctionMetrics(
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

export function computeCallGraph(functions: FnRecord[]): CallGraphMetrics {
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
