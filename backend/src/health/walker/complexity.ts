import type { Node } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';
import type { NodeKinds } from '../nodeKinds/index.js';

const SHORT_CIRCUIT_OPS_TS = new Set(['&&', '||', '??']);
const PY_BOOL_OP_TYPE = 'boolean_operator';

export function isShortCircuitOperator(node: Node, grammar: GrammarKey): string | null {
  if (grammar === 'python') {
    if (node.type === PY_BOOL_OP_TYPE) {
      const op = node.childForFieldName('operator');
      if (op) return op.type;
      for (const c of node.children) {
        if (c && (c.type === 'and' || c.type === 'or')) return c.type;
      }
    }
    return null;
  }
  if (node.type !== 'binary_expression') return null;
  for (const c of node.children) {
    if (!c) continue;
    if (SHORT_CIRCUIT_OPS_TS.has(c.type)) return c.type;
  }
  return null;
}

// Sonar B1: an `if` chained as the `alternative` of another
// `if_statement` (i.e. `else if`) is a continuation, not a new
// decision. It costs +1 cognitive (no nesting bump) and does NOT
// push another nesting level. The previous behavior treated each
// else-if as a fresh nested if, so a 4-arm router cost 1+2+3+4=10
// cognitive vs. Sonar's 1+1+1+1=4 — routinely tripping the
// high_cognitive_complexity threshold on routine dispatch code.
//
// Tree-sitter-typescript wraps `else` in an `else_clause` node, so
// the actual chain looks like:
//   if_statement (outer)
//     alternative: else_clause
//       if_statement (THIS is the else-if)
// We detect both that wrapping and the rare unwrapped form.
export function detectElseIf(node: Node, t: string, isJsFamily: boolean): boolean {
  if (!isJsFamily || t !== 'if_statement') return false;
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'else_clause') {
    const grand = parent.parent;
    return !!grand && grand.type === 'if_statement';
  }
  if (parent.type === 'if_statement') {
    return parent.childForFieldName('alternative')?.id === node.id;
  }
  return false;
}

export function computeComplexityAdds(
  node: Node,
  kinds: NodeKinds,
  grammar: GrammarKey,
  nesting: number,
  isElseIf: boolean,
): { cyclomaticAdd: number; cognitiveAdd: number; opensNesting: boolean } {
  const t = node.type;
  let cyclomaticAdd = 0;
  let cognitiveAdd = 0;

  if (kinds.branch.has(t)) {
    cyclomaticAdd = 1;
  }
  if (kinds.cognitiveBranch.has(t)) {
    cognitiveAdd = isElseIf ? 1 : 1 + nesting;
  }
  // Cyclomatic still counts each else-if as a path (McCabe), but
  // cognitive treats it as a continuation, and we don't increase
  // the nesting depth for else-if since semantically the chain
  // lives at the original `if`'s depth.
  const opensNesting = kinds.nesting.has(t) && !isElseIf;
  const op = isShortCircuitOperator(node, grammar);
  if (op) {
    cyclomaticAdd += 1;
    const parent = node.parent;
    const parentOp = parent ? isShortCircuitOperator(parent, grammar) : null;
    if (parentOp !== op) cognitiveAdd += 1;
  }
  return { cyclomaticAdd, cognitiveAdd, opensNesting };
}
