import type { Node } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';

export function hasFunctionDocstring(node: Node, grammar: GrammarKey): boolean {
  if (grammar !== 'python') return false;

  const body = node.childForFieldName('body');
  if (!body || body.namedChildCount === 0) return false;

  const first = body.namedChild(0);
  return !!(
    first &&
    first.type === 'expression_statement' &&
    first.namedChildCount > 0 &&
    first.namedChild(0)?.type === 'string'
  );
}
