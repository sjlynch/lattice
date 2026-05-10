import type { NodeKinds } from './index.js';

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
  return {
    function: new Set(CSHARP_FUNCTION_KINDS),
    namedFunction: new Set([
      'method_declaration',
      'constructor_declaration',
      'local_function_statement',
    ]),
    anonymousFunction: new Set([
      'lambda_expression',
      'anonymous_method_expression',
    ]),
    class: new Set(['class_declaration', 'struct_declaration', 'record_declaration']),
    interface: new Set(['interface_declaration']),
    import: new Set(),
    branch: new Set(CSHARP_BRANCH_KINDS),
    cognitiveBranch: new Set(CSHARP_COGNITIVE_BRANCH_KINDS),
    nesting: new Set(CSHARP_NESTING_KINDS),
    ternary: new Set(['conditional_expression']),
    catchClause: new Set(['catch_clause']),
    call: new Set(['invocation_expression', 'object_creation_expression']),
    string: new Set([
      'string_literal',
      'verbatim_string_literal',
      'interpolated_string_expression',
    ]),
    comment: new Set(['comment']),
    importSourceField: 'name',
  };
}
