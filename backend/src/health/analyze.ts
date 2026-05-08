// Main entry: parse a file with tree-sitter and compute its
// HealthMetrics. Returns a partial result without the cross-file
// fields (fanIn / fanOut / inCycle); crossFile.ts patches those in
// after the per-file pass for the whole project completes.

import type { HealthLanguage, HealthMetrics, HealthSmellId } from './types.js';
import { SMELL_LABELS } from './types.js';
import { getParser, grammarKeyForExt, type GrammarKey } from './parser.js';
import { analyzeTree } from './walker.js';
import { computeHalstead, computeMaintainabilityIndex } from './halstead.js';
import {
  COMMENT_BY_EXT,
  countLineKinds,
  countUniversalSmells,
  bump,
  type SmellCounter,
} from './universal.js';
import { computeScore } from './score.js';

const TS_EXTS = new Set(['.ts', '.tsx']);
const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const PY_EXTS = new Set(['.py', '.pyi']);

const AST_MAX_BYTES = 1024 * 1024;

function languageForExt(ext: string): HealthLanguage {
  if (TS_EXTS.has(ext)) return 'typescript';
  if (JS_EXTS.has(ext)) return 'javascript';
  if (PY_EXTS.has(ext)) return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.java') return 'java';
  if (ext === '.cs') return 'csharp';
  if (ext === '.rb') return 'ruby';
  return 'fallback';
}

function smellsToArray(smells: SmellCounter) {
  const out: { id: HealthSmellId; count: number; label: string }[] = [];
  for (const [id, count] of smells) {
    if (count > 0) out.push({ id, count, label: SMELL_LABELS[id] });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
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
  if (totalLoc > 800) bump(smells, 'large_file');
  const smellList = smellsToArray(smells);
  let smellCount = 0;
  for (const s of smellList) smellCount += s.count;

  const components = {
    loc: totalLoc,
    commentRatio,
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

function computeFromTree(
  tree: import('web-tree-sitter').Tree,
  content: string,
  ext: string,
  totalLoc: number,
  language: HealthLanguage,
  grammar: GrammarKey,
): AnalyzeResult {
  const analysis = analyzeTree(tree, grammar, content);

  // ---- Per-function aggregates ----
  let cycMax = 0;
  let cycTotal = 0;
  let cogMax = 0;
  let cogTotal = 0;
  let lenMax = 0;
  let lenTotal = 0;
  let paramMax = 0;
  let nestMax = 0;
  let booleanParams = 0;
  let mixedSyncAsync = 0;
  let missingDocstrings = 0;
  let namedFunctionCount = 0;

  for (const fn of analysis.functions) {
    if (!fn.isAnonymous) namedFunctionCount++;
    if (fn.cyclomatic > cycMax) cycMax = fn.cyclomatic;
    cycTotal += fn.cyclomatic;
    if (fn.cognitive > cogMax) cogMax = fn.cognitive;
    cogTotal += fn.cognitive;
    // Use ownLines for the "function length" metric — see walker.ts.
    const len = Math.max(1, fn.ownLines);
    if (len > lenMax) lenMax = len;
    lenTotal += len;
    if (fn.paramCount > paramMax) paramMax = fn.paramCount;
    if (fn.maxNestingDepth > nestMax) nestMax = fn.maxNestingDepth;
    booleanParams += fn.booleanParamCount;
    if (fn.isAsync && !fn.hasAwait) mixedSyncAsync++;
    if (
      grammar === 'python' &&
      !fn.hasDocstring &&
      fn.name &&
      !fn.name.startsWith('_')
    ) {
      missingDocstrings++;
    }
  }

  const avgLen = analysis.functions.length > 0 ? lenTotal / analysis.functions.length : 0;

  // ---- Halstead + Maintainability Index ----
  const halstead = computeHalstead(tree);
  const avgCyc = analysis.functions.length > 0 ? cycTotal / analysis.functions.length : 0;
  const maintainabilityIndex = computeMaintainabilityIndex(
    halstead.volume,
    avgCyc,
    Math.max(1, totalLoc),
  );

  // ---- Comment ratio ----
  const lineCounts = countLineKinds(content, COMMENT_BY_EXT[ext] ?? { line: ['//'] });
  const denom = lineCounts.code + lineCounts.comment;
  const commentRatio = denom > 0 ? lineCounts.comment / denom : 0;

  // ---- Within-file call graph density ----
  // For each function, count how many of its calls resolve to another
  // function defined in this file. Sum / functionCount = density.
  // Range: 0 (functions don't call each other) to ~1 (each function
  // calls every other function — god-function pattern).
  const fnNamesInFile = new Set<string>();
  for (const fn of analysis.functions) {
    if (fn.name) fnNamesInFile.add(fn.name);
  }
  let internalCallTotal = 0;
  let godishCount = 0;
  for (const fn of analysis.functions) {
    let internal = 0;
    for (const c of fn.calls) {
      if (fnNamesInFile.has(c)) internal++;
    }
    internalCallTotal += internal;
    // "god function" heuristic: calls 50%+ of the other functions in
    // the file, and there are at least 4 other functions.
    const others = fnNamesInFile.size - (fn.name ? 1 : 0);
    if (others >= 4 && internal >= Math.max(4, Math.floor(others * 0.5))) {
      godishCount++;
    }
  }
  const callGraphDensity =
    analysis.functions.length > 0 ? internalCallTotal / analysis.functions.length : 0;
  const godFunctionRatio =
    analysis.functions.length > 0 ? godishCount / analysis.functions.length : 0;

  // ---- Smells (merge AST tokens + universal regex + aggregate-derived) ----
  const smells: SmellCounter = new Map();
  const t = analysis.smellTokens;
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

  if (booleanParams > 0) bump(smells, 'boolean_param', booleanParams);
  if (mixedSyncAsync > 0) bump(smells, 'mixed_sync_async', mixedSyncAsync);
  if (missingDocstrings > 0) bump(smells, 'missing_docstring', missingDocstrings);

  // Magic strings: literals appearing 3+ times.
  let magicStrings = 0;
  for (const count of analysis.stringLiterals.values()) {
    if (count >= 3) magicStrings++;
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
  if (totalLoc > 800) bump(smells, 'large_file');
  if (namedFunctionCount > 20) bump(smells, 'high_function_count');
  if (analysis.classCount > 1) {
    bump(smells, 'multiple_classes', analysis.classCount - 1);
  }
  if (cycMax > 15) bump(smells, 'high_complexity');
  if (cogMax > 15) bump(smells, 'high_cognitive_complexity');
  if (nestMax > 5) bump(smells, 'deep_nesting');
  if (lenMax > 75) bump(smells, 'long_function');
  if (paramMax > 5) bump(smells, 'long_param_list');
  if (maintainabilityIndex < 65) bump(smells, 'low_maintainability');
  if (godishCount > 0) bump(smells, 'god_function', godishCount);

  const smellList = smellsToArray(smells);
  let smellCount = 0;
  for (const s of smellList) smellCount += s.count;

  const components = {
    loc: totalLoc,
    commentRatio,
    cyclomaticMax: cycMax,
    cyclomaticTotal: cycTotal,
    cognitiveMax: cogMax,
    cognitiveTotal: cogTotal,
    maxNestingDepth: nestMax,
    halstead,
    maintainabilityIndex,
    functionCount: analysis.functions.length,
    namedFunctionCount,
    avgFunctionLength: avgLen,
    maxFunctionLength: lenMax,
    maxParamCount: paramMax,
    classCount: analysis.classCount,
    callGraphDensity,
    godFunctionRatio,
    smells: smellList,
    smellCount,
  };

  return {
    metrics: { ...components, score: computeScore(components), language },
    imports: analysis.imports,
  };
}
