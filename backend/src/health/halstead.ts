// Halstead metrics + Maintainability Index. We approximate operators
// and operands from the tree-sitter token stream:
//   - "Operators" = anonymous tokens (the grammar's literal strings:
//     punctuation, keywords like `if`/`for`, operator symbols)
//   - "Operands" = identifiers + literal nodes (string/number/regex)
//
// Halstead's original 1977 definitions are language-agnostic and were
// designed for procedural code, so this approximation is plenty for
// the score. We then plug `volume` into Microsoft's normalized
// Maintainability Index formula.

import type { Node, Tree } from 'web-tree-sitter';
import type { HalsteadMetrics } from './types.js';

const OPERAND_NODE_TYPES = new Set([
  'identifier',
  'property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'private_property_identifier',
  'type_identifier',
  'string',
  'template_string',
  'number',
  'integer',
  'float',
  'true',
  'false',
  'null',
  'undefined',
  'none',
  'regex',
  'regex_pattern',
  'string_fragment',
]);

const SKIP_ANONYMOUS = new Set<string>([
  // Pure formatting punctuation that doesn't really represent an
  // operator in the Halstead sense (commas, semicolons, brackets).
  // Excluding these keeps the operator vocabulary focused on
  // semantically meaningful tokens.
  ',', ';', '(', ')', '{', '}', '[', ']', ':',
  // Newlines / EOF / whitespace
  '\n',
]);

export function computeHalstead(tree: Tree): HalsteadMetrics {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();

  function visit(node: Node) {
    const t = node.type;
    if (node.isNamed) {
      if (OPERAND_NODE_TYPES.has(t)) {
        const text = node.text;
        // For string nodes, use the full text (quotes included) so
        // distinct strings are distinct operands.
        operands.set(text, (operands.get(text) ?? 0) + 1);
        return;
      }
    } else {
      // Anonymous node: its `type` IS the literal text.
      if (!SKIP_ANONYMOUS.has(t) && t.length > 0) {
        operators.set(t, (operators.get(t) ?? 0) + 1);
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  }

  visit(tree.rootNode);

  const n1 = operators.size;
  const n2 = operands.size;
  let N1 = 0;
  let N2 = 0;
  for (const v of operators.values()) N1 += v;
  for (const v of operands.values()) N2 += v;

  const vocabulary = n1 + n2;
  const length = N1 + N2;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;
  const effort = volume * difficulty;

  return { vocabulary, length, volume, difficulty, effort };
}

// Microsoft's normalized 0–100 Maintainability Index. ≥85 healthy,
// 65–85 moderate, <65 poor.
//
// MI = max(0, (171 - 5.2 * ln(V) - 0.23 * G - 16.2 * ln(LOC)) * 100/171)
//
// `G` here is a representative cyclomatic complexity for the file —
// we use the average of all per-function CC values so files with
// many simple functions don't get unduly penalized by one outlier.
export function computeMaintainabilityIndex(
  halsteadVolume: number,
  avgCyclomatic: number,
  loc: number,
): number {
  if (loc <= 0 || halsteadVolume <= 0) return 100;
  const lnV = Math.log(Math.max(1, halsteadVolume));
  const lnL = Math.log(Math.max(1, loc));
  const raw = 171 - 5.2 * lnV - 0.23 * avgCyclomatic - 16.2 * lnL;
  const normalized = (raw * 100) / 171;
  if (!Number.isFinite(normalized)) return 0;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}
