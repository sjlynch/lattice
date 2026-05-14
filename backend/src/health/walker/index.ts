// Tree-sitter AST walker. Single recursive pass over the file's tree,
// extracting per-function records (length, params, cyclomatic,
// cognitive, nesting, call set, async/await, docstring) plus
// file-level totals (class count, interface count, imports, string
// literal occurrences for the magic-string check).
//
// Cognitive complexity follows SonarSource's "B1" specification:
// linearity-breaking control structures add `1 + currentNesting`,
// non-nesting alternatives like `else` add 1, and short-circuit
// operator sequences add 1 each time the operator changes.

import type { Node, Tree } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';
import { nodeKindsFor } from '../nodeKinds/index.js';
import { type FnRecord } from './functionRecord.js';
import type { WalkerContext } from './context.js';
import {
  handleAstSmells,
  handleAwaitExpression,
  handleCallExpression,
  handleComment,
  handleExportTracking,
  handleFileStructure,
  handleFunctionEntry,
  handleFunctionExit,
  handleImportsAndStrings,
  updateComplexity,
} from './visitors.js';

export type { FnRecord };
export type { WalkerContext } from './context.js';

export type FileAnalysis = {
  functions: FnRecord[];
  classCount: number;
  interfaceCount: number;
  imports: string[];
  // Counts for AST-driven smells detected during the walk.
  smellTokens: {
    anyType: number;
    typeAssertion: number;
    nonNullAssertion: number;
    debuggerStmt: number;
    consoleCalls: number;
    evalCalls: number;
    varDecls: number;
    looseEquality: number;
    emptyCatch: number;
    deepOptionalChain: number;
    deepTernary: number;
    emptyInterface: number;
    printCalls: number;
    bareExcept: number;
    wildcardImport: number;
    mutableDefaultArg: number;
    globalKeyword: number;
    tsIgnore: number;
    eslintDisable: number;
    mixedExports: number;
  };
  // For magic-string detection: literal -> count
  stringLiterals: Map<string, number>;
};

export function analyzeTree(
  tree: Tree,
  grammar: GrammarKey,
  source: string,
): FileAnalysis {
  const ctx: WalkerContext = {
    result: createFileAnalysis(),
    grammar,
    kinds: nodeKindsFor(grammar),
    isJsFamily:
      grammar === 'typescript' || grammar === 'tsx' || grammar === 'javascript',
    isTs: grammar === 'typescript' || grammar === 'tsx',
    fnStack: [],
    exportState: {
      hasDefaultExport: false,
      namedExportCount: 0,
    },
  };

  walk(ctx, tree.rootNode, 0);

  if (ctx.exportState.hasDefaultExport && ctx.exportState.namedExportCount >= 5) {
    ctx.result.smellTokens.mixedExports = 1;
  }

  // Reserved for future passes (e.g., reading raw text by byte range).
  void source;

  return ctx.result;
}

function walk(ctx: WalkerContext, node: Node, nesting: number): void {
  const t = node.type;

  // Comment nodes are terminal for the health pass: record comment-only smell
  // markers and do not descend into their token children.
  if (handleComment(ctx, node, t)) return;

  const pushedFn = handleFunctionEntry(ctx, node, t);
  if (pushedFn) {
    // Sonar's spec: nesting resets at each function boundary.
    nesting = 0;
  }

  handleFileStructure(ctx, node, t);
  handleImportsAndStrings(ctx, node, t);
  handleAstSmells(ctx, node, t);
  handleExportTracking(ctx, node, t);

  const pushedNesting = updateComplexity(ctx, node, t, nesting);
  handleAwaitExpression(ctx, t);
  handleCallExpression(ctx, node, t);

  for (const c of node.namedChildren) {
    if (c) walk(ctx, c, pushedNesting ? nesting + 1 : nesting);
  }

  handleFunctionExit(ctx, pushedFn);
}

function createFileAnalysis(): FileAnalysis {
  return {
    functions: [],
    classCount: 0,
    interfaceCount: 0,
    imports: [],
    smellTokens: {
      anyType: 0,
      typeAssertion: 0,
      nonNullAssertion: 0,
      debuggerStmt: 0,
      consoleCalls: 0,
      evalCalls: 0,
      varDecls: 0,
      looseEquality: 0,
      emptyCatch: 0,
      deepOptionalChain: 0,
      deepTernary: 0,
      emptyInterface: 0,
      printCalls: 0,
      bareExcept: 0,
      wildcardImport: 0,
      mutableDefaultArg: 0,
      globalKeyword: 0,
      tsIgnore: 0,
      eslintDisable: 0,
      mixedExports: 0,
    },
    stringLiterals: new Map(),
  };
}
