import type { Node } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';
import type { NodeKinds } from '../nodeKinds/index.js';
import type { FileAnalysis } from './index.js';
import { hasFunctionDocstring } from './docstrings.js';
import { getFunctionName } from './functionNames.js';
import {
  getParameterCount,
  getParameterNodes,
  isBooleanParam,
  isMutableDefaultPython,
} from './parameters.js';

export { getFunctionName } from './functionNames.js';
export {
  getParameterCount,
  isBooleanParam,
  isMutableDefaultPython,
} from './parameters.js';

export type FnRecord = {
  node: Node;
  name: string | null;
  isAnonymous: boolean;
  isAsync: boolean;
  hasAwait: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  // Lines belonging to this function's own scope (excluding nested
  // function bodies). Better signal of "is this function itself long"
  // than `totalLines` for a React component or Python class with many
  // methods.
  ownLines: number;
  cyclomatic: number;
  cognitive: number;
  maxNestingDepth: number;
  paramCount: number;
  booleanParamCount: number;
  hasDocstring: boolean;
  // Names of called functions/methods (just the leaf identifier).
  // Used for the within-file call graph density metric.
  calls: Set<string>;
};

export function lineSpan(node: Node): { startLine: number; endLine: number; total: number } {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  return { startLine, endLine, total: Math.max(1, endLine - startLine + 1) };
}

export function recordFunction(
  node: Node,
  grammar: GrammarKey,
  kinds: NodeKinds,
  smellTokens: FileAnalysis['smellTokens'],
): FnRecord {
  const span = lineSpan(node);
  const name = getFunctionName(node, grammar);
  const isAnonymous =
    kinds.anonymousFunction.has(node.type) && name === null;
  const fn: FnRecord = {
    node,
    name,
    isAnonymous,
    isAsync: false,
    hasAwait: false,
    startLine: span.startLine,
    endLine: span.endLine,
    totalLines: span.total,
    ownLines: span.total,
    cyclomatic: 1,
    cognitive: 0,
    maxNestingDepth: 0,
    paramCount: getParameterCount(node, grammar),
    booleanParamCount: 0,
    hasDocstring: false,
    calls: new Set(),
  };
  for (const c of node.children) {
    if (c && c.type === 'async') {
      fn.isAsync = true;
      break;
    }
  }
  for (const p of getParameterNodes(node)) {
    if (isBooleanParam(p, grammar)) fn.booleanParamCount++;
    if (grammar === 'python' && isMutableDefaultPython(p)) {
      smellTokens.mutableDefaultArg++;
    }
  }
  fn.hasDocstring = hasFunctionDocstring(node, grammar);
  return fn;
}
