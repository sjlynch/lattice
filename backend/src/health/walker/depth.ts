import type { Node } from 'web-tree-sitter';
import type { NodeKinds } from '../nodeKinds/index.js';

// Optional-chain depth: count how many `?.` tokens appear in a
// single chain. Tree-sitter-typescript wraps each `?.` in a *named*
// `optional_chain` node whose own child is the anonymous `?.` token,
// so we have to check both the wrapping node type AND the literal
// token type to be robust across grammar versions.
export function countOptionalChainDepth(node: Node): number {
  let depth = 0;
  let cur: Node | null = node;
  while (cur) {
    const t = cur.type;
    if (
      t !== 'member_expression' &&
      t !== 'subscript_expression' &&
      t !== 'call_expression'
    ) {
      break;
    }
    let hasOptional = false;
    for (const c of cur.children) {
      if (!c) continue;
      if (c.type === 'optional_chain' || c.type === '?.') {
        hasOptional = true;
        break;
      }
    }
    if (hasOptional) depth++;
    cur = cur.namedChildren[0] ?? null;
  }
  return depth;
}

// Detect ternary nesting depth at this node. At each ternary, walk
// the consequence/alternative sub-trees and count the deepest
// nested ternary chain.
export function countTernaryDepth(node: Node, kinds: NodeKinds): number {
  if (!kinds.ternary.has(node.type)) return 0;
  let max = 0;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const d = countTernaryDepthInner(c, kinds);
    if (d > max) max = d;
  }
  return 1 + max;
}

function countTernaryDepthInner(node: Node, kinds: NodeKinds): number {
  if (kinds.ternary.has(node.type)) return countTernaryDepth(node, kinds);
  let max = 0;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const d = countTernaryDepthInner(c, kinds);
    if (d > max) max = d;
  }
  return max;
}
