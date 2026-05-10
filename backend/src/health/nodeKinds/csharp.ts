import { buildNodeKinds, type NodeKinds } from './base.js';

const CSHARP_FUNCTION_KINDS = [
  'method_declaration',
  'constructor_declaration',
  'local_function_statement',
  'lambda_expression',
  'anonymous_method_expression',
];
const CSHARP_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'for_each_statement',
  'while_statement',
  'do_statement',
  'switch_section',
  'catch_clause',
  'conditional_expression',
];
const CSHARP_COGNITIVE_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'for_each_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'catch_clause',
  'conditional_expression',
];
const CSHARP_NESTING_KINDS = [
  'if_statement',
  'for_statement',
  'for_each_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
  'catch_clause',
  'conditional_expression',
];

export function buildCsharpNodeKinds(): NodeKinds {
  return buildNodeKinds({
    functionKinds: CSHARP_FUNCTION_KINDS,
    namedFunctionKinds: [
      'method_declaration',
      'constructor_declaration',
      'local_function_statement',
    ],
    anonymousFunctionKinds: [
      'lambda_expression',
      'anonymous_method_expression',
    ],
    classKinds: ['class_declaration', 'struct_declaration', 'record_declaration'],
    interfaceKinds: ['interface_declaration'],
    branchKinds: CSHARP_BRANCH_KINDS,
    cognitiveBranchKinds: CSHARP_COGNITIVE_BRANCH_KINDS,
    nestingKinds: CSHARP_NESTING_KINDS,
    ternaryKinds: ['conditional_expression'],
    catchClauseKinds: ['catch_clause'],
    callKinds: ['invocation_expression', 'object_creation_expression'],
    stringKinds: [
      'string_literal',
      'verbatim_string_literal',
      'interpolated_string_expression',
    ],
    commentKinds: ['comment'],
    importSourceField: 'name',
  });
}
