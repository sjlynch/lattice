import type { Node } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';
import type { NodeKinds } from '../nodeKinds/index.js';
import type { FileAnalysis } from './index.js';

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

// Pull a name out of a function-like node. For named declarations
// (function/method/generator) the grammar exposes a `name` field;
// for arrow functions and function expressions we look at the
// enclosing `variable_declarator` (`const X = () => {}`), object
// literal pair (`{ foo: () => {} }`), or class field
// (`foo = () => {}`) so React's idiomatic component definitions get
// counted as NAMED rather than anonymous.
export function getFunctionName(node: Node, grammar: GrammarKey): string | null {
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;

  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    const parent = node.parent;
    if (parent) {
      if (parent.type === 'variable_declarator') {
        const id = parent.childForFieldName('name');
        if (id && id.type === 'identifier') return id.text;
      }
      if (parent.type === 'pair') {
        const key = parent.childForFieldName('key');
        if (key) return key.text;
      }
      if (
        parent.type === 'public_field_definition' ||
        parent.type === 'field_definition'
      ) {
        const name = parent.childForFieldName('name');
        if (name) return name.text;
      }
      if (parent.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
        if (left) {
          if (left.type === 'identifier') return left.text;
          // `Object.foo = () => {}` / `module.exports.bar = () => {}`
          // — return the leaf property name. Without this the function
          // is recorded as anonymous and excluded from named-function
          // counts, god-function detection, and the magic-string
          // import exclusion.
          if (left.type === 'member_expression') {
            const prop = left.childForFieldName('property');
            if (prop) return prop.text;
          }
        }
      }
    }
  }

  if (grammar === 'python') {
    for (const c of node.namedChildren) {
      if (c && c.type === 'identifier') return c.text;
    }
  }
  return null;
}

export function getParameterCount(node: Node, grammar: GrammarKey): number {
  // Different grammars expose params under different field names.
  // Try the common ones; fall back to a heuristic search.
  const params =
    node.childForFieldName('parameters') ||
    node.childForFieldName('parameter') ||
    null;
  if (params) {
    let count = 0;
    for (const c of params.namedChildren) {
      if (!c) continue;
      // Skip type annotation nodes (TS) and skip the brackets themselves.
      const t = c.type;
      if (t === 'type_annotation' || t === 'comment') continue;
      count++;
    }
    return count;
  }
  if (grammar === 'python') {
    // Python lambdas: parameters listed before the colon.
    const paramsNode = node.namedChildren.find(
      (c) => c?.type === 'parameters' || c?.type === 'lambda_parameters',
    );
    if (paramsNode) {
      return paramsNode.namedChildren.filter((c) => c && c.type !== 'comment').length;
    }
  }
  return 0;
}

export function isBooleanParam(node: Node, grammar: GrammarKey): boolean {
  if (grammar === 'python') {
    // Plain annotation: `def f(x: bool)`.
    if (node.type === 'typed_parameter') {
      const typeNode = node.childForFieldName('type');
      if (typeNode && /\bbool\b/.test(typeNode.text)) return true;
    }
    // Untyped default: `def f(x=True)`.
    if (node.type === 'default_parameter') {
      const valueNode = node.childForFieldName('value');
      if (valueNode && (valueNode.text === 'True' || valueNode.text === 'False')) return true;
    }
    // Annotated AND defaulted: `def f(x: bool = True)` — by far the
    // most common form in real Python code, missed by the original
    // implementation which only checked the two cases above.
    if (node.type === 'typed_default_parameter') {
      const typeNode = node.childForFieldName('type');
      if (typeNode && /\bbool\b/.test(typeNode.text)) return true;
      const valueNode = node.childForFieldName('value');
      if (valueNode && (valueNode.text === 'True' || valueNode.text === 'False')) return true;
    }
    return false;
  }
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    const typeNode = node.childForFieldName('type');
    if (typeNode && /\bboolean\b/.test(typeNode.text)) return true;
  }
  return false;
}

export function isMutableDefaultPython(node: Node): boolean {
  if (node.type !== 'default_parameter' && node.type !== 'typed_default_parameter') {
    return false;
  }
  const value = node.childForFieldName('value');
  if (!value) return false;
  const t = value.type;
  return t === 'list' || t === 'dictionary' || t === 'set';
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
  const params =
    node.childForFieldName('parameters') ||
    node.childForFieldName('parameter') ||
    null;
  if (params) {
    for (const p of params.namedChildren) {
      if (!p) continue;
      if (isBooleanParam(p, grammar)) fn.booleanParamCount++;
      if (grammar === 'python' && isMutableDefaultPython(p)) {
        smellTokens.mutableDefaultArg++;
      }
    }
  }
  if (grammar === 'python') {
    const body = node.childForFieldName('body');
    if (body && body.namedChildCount > 0) {
      const first = body.namedChild(0);
      if (
        first &&
        first.type === 'expression_statement' &&
        first.namedChildCount > 0 &&
        first.namedChild(0)?.type === 'string'
      ) {
        fn.hasDocstring = true;
      }
    }
  }
  return fn;
}
