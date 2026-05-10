import { buildNodeKinds, type NodeKinds } from './base.js';

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
  return buildNodeKinds({
    functionKinds: JAVA_FUNCTION_KINDS,
    namedFunctionKinds: ['method_declaration', 'constructor_declaration'],
    anonymousFunctionKinds: ['lambda_expression'],
    classKinds: ['class_declaration', 'enum_declaration', 'record_declaration'],
    interfaceKinds: ['interface_declaration'],
    branchKinds: JAVA_BRANCH_KINDS,
    cognitiveBranchKinds: JAVA_COGNITIVE_BRANCH_KINDS,
    nestingKinds: JAVA_NESTING_KINDS,
    ternaryKinds: ['ternary_expression'],
    catchClauseKinds: ['catch_clause'],
    callKinds: ['method_invocation', 'object_creation_expression'],
    stringKinds: ['string_literal'],
    commentKinds: ['line_comment', 'block_comment'],
    importSourceField: 'name',
  });
}
