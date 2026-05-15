import type { Node } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';

export function getParameterCount(node: Node, grammar: GrammarKey): number {
  const params = getPrimaryParameterContainer(node);
  if (params) return countParameterChildren(params);

  if (grammar === 'python') {
    // Python lambdas: parameters listed before the colon.
    const paramsNode = node.namedChildren.find(
      (c) => c?.type === 'parameters' || c?.type === 'lambda_parameters',
    );
    if (paramsNode) return countParameterChildren(paramsNode);
  }

  return 0;
}

export function getParameterNodes(node: Node): Node[] {
  const params = getPrimaryParameterContainer(node);
  if (!params) return [];
  return params.namedChildren.filter((c): c is Node => !!c);
}

function getPrimaryParameterContainer(node: Node): Node | null {
  // Different grammars expose params under different field names. Try the common
  // ones; callers that only need a count can add grammar-specific fallbacks.
  return (
    node.childForFieldName('parameters') ||
    node.childForFieldName('parameter') ||
    null
  );
}

function countParameterChildren(params: Node): number {
  let count = 0;
  for (const c of params.namedChildren) {
    if (!c || isNonParameterChild(c)) continue;
    count++;
  }
  return count;
}

function isNonParameterChild(node: Node): boolean {
  // Skip type annotation nodes (TS) and skip comments.
  return node.type === 'type_annotation' || node.type === 'comment';
}

export function isBooleanParam(node: Node, grammar: GrammarKey): boolean {
  if (grammar === 'python') return isPythonBooleanParam(node);
  return isTsBooleanParam(node);
}

function isTsBooleanParam(node: Node): boolean {
  if (node.type !== 'required_parameter' && node.type !== 'optional_parameter') {
    return false;
  }
  const typeNode = node.childForFieldName('type');
  return !!typeNode && /\bboolean\b/.test(typeNode.text);
}

function isPythonBooleanParam(node: Node): boolean {
  // Plain annotation: `def f(x: bool)`.
  if (node.type === 'typed_parameter') {
    return hasPythonBoolType(node);
  }
  // Untyped default: `def f(x=True)`.
  if (node.type === 'default_parameter') {
    return hasPythonBooleanDefault(node);
  }
  // Annotated AND defaulted: `def f(x: bool = True)` — by far the most common
  // form in real Python code.
  if (node.type === 'typed_default_parameter') {
    return hasPythonBoolType(node) || hasPythonBooleanDefault(node);
  }
  return false;
}

function hasPythonBoolType(node: Node): boolean {
  const typeNode = node.childForFieldName('type');
  return !!typeNode && /\bbool\b/.test(typeNode.text);
}

function hasPythonBooleanDefault(node: Node): boolean {
  const valueNode = node.childForFieldName('value');
  return !!valueNode && (valueNode.text === 'True' || valueNode.text === 'False');
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
