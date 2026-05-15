import type { Node } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';

export function getFunctionName(node: Node, grammar: GrammarKey): string | null {
  return (
    getGenericNameField(node) ??
    getTsJsEnclosingFunctionName(node) ??
    (grammar === 'python' ? getPythonIdentifierFallback(node) : null)
  );
}

export function getGenericNameField(node: Node): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

// For arrow functions and function expressions we look at the enclosing
// variable_declarator (`const X = () => {}`), object literal pair
// (`{ foo: () => {} }`), class field (`foo = () => {}`), or assignment
// (`Object.foo = () => {}`) so React's idiomatic component definitions get
// counted as NAMED rather than anonymous.
export function getTsJsEnclosingFunctionName(node: Node): string | null {
  if (node.type !== 'arrow_function' && node.type !== 'function_expression') {
    return null;
  }

  const parent = node.parent;
  if (!parent) return null;

  return (
    nameFromVariableDeclarator(parent) ??
    nameFromObjectPair(parent) ??
    nameFromClassField(parent) ??
    nameFromAssignment(parent)
  );
}

function nameFromVariableDeclarator(parent: Node): string | null {
  if (parent.type !== 'variable_declarator') return null;
  const id = parent.childForFieldName('name');
  return id?.type === 'identifier' ? id.text : null;
}

function nameFromObjectPair(parent: Node): string | null {
  if (parent.type !== 'pair') return null;
  return parent.childForFieldName('key')?.text ?? null;
}

function nameFromClassField(parent: Node): string | null {
  if (
    parent.type !== 'public_field_definition' &&
    parent.type !== 'field_definition'
  ) {
    return null;
  }
  return parent.childForFieldName('name')?.text ?? null;
}

function nameFromAssignment(parent: Node): string | null {
  if (parent.type !== 'assignment_expression') return null;

  const left = parent.childForFieldName('left');
  if (!left) return null;
  if (left.type === 'identifier') return left.text;

  // `Object.foo = () => {}` / `module.exports.bar = () => {}` — return the
  // leaf property name. Without this the function is recorded as anonymous and
  // excluded from named-function counts, god-function detection, and the
  // magic-string import exclusion.
  if (left.type === 'member_expression') {
    return left.childForFieldName('property')?.text ?? null;
  }

  return null;
}

export function getPythonIdentifierFallback(node: Node): string | null {
  for (const c of node.namedChildren) {
    if (c && c.type === 'identifier') return c.text;
  }
  return null;
}
