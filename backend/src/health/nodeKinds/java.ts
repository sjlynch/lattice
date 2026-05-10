import type { NodeKinds } from './index.js';

const JAVA_FUNCTION_KINDS = [
  'method_declaration',
  'constructor_declaration',
  'lambda_expression',
];
const JAVA_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'switch_label',
  'catch_clause',
  'ternary_expression',
];
// Java has BOTH classic `switch_statement` and the Java 14+
// `switch_expression`. Both dispatch and both deserve the cognitive
// nesting penalty; registering only `switch_expression` (the
// original) silently let routine `switch (x) { case A: ... }`
// statements escape any cognitive cost.
const JAVA_COGNITIVE_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'switch_expression',
  'catch_clause',
  'ternary_expression',
];
const JAVA_NESTING_KINDS = [
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'switch_expression',
  'try_statement',
  'catch_clause',
  'ternary_expression',
];

export function buildJavaNodeKinds(): NodeKinds {
  return {
    function: new Set(JAVA_FUNCTION_KINDS),
    namedFunction: new Set(['method_declaration', 'constructor_declaration']),
    anonymousFunction: new Set(['lambda_expression']),
    class: new Set(['class_declaration', 'enum_declaration', 'record_declaration']),
    interface: new Set(['interface_declaration']),
    import: new Set(),
    branch: new Set(JAVA_BRANCH_KINDS),
    cognitiveBranch: new Set(JAVA_COGNITIVE_BRANCH_KINDS),
    nesting: new Set(JAVA_NESTING_KINDS),
    ternary: new Set(['ternary_expression']),
    catchClause: new Set(['catch_clause']),
    call: new Set(['method_invocation', 'object_creation_expression']),
    string: new Set(['string_literal']),
    comment: new Set(['line_comment', 'block_comment']),
    importSourceField: 'name',
  };
}
