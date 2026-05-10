import type { NodeKinds } from './index.js';

const PY_FUNCTION_KINDS = ['function_definition', 'lambda'];
const PY_NAMED_FUNCTION_KINDS = ['function_definition'];
const PY_BRANCH_KINDS = [
  'if_statement',
  'elif_clause',
  'for_statement',
  'while_statement',
  'except_clause',
  'conditional_expression',
];
// Python has no switch in the JS sense (3.10's match_statement is
// closer to switch but cases are pattern matches — keep them out of
// the cognitive set for now to avoid the same over-counting we hit
// on JS/TS switches).
const PY_COGNITIVE_BRANCH_KINDS = PY_BRANCH_KINDS;
const PY_NESTING_KINDS = [
  'if_statement',
  'elif_clause',
  'for_statement',
  'while_statement',
  'try_statement',
  'with_statement',
  'conditional_expression',
];

export function buildPythonNodeKinds(): NodeKinds {
  return {
    function: new Set(PY_FUNCTION_KINDS),
    namedFunction: new Set(PY_NAMED_FUNCTION_KINDS),
    anonymousFunction: new Set(['lambda']),
    class: new Set(['class_definition']),
    interface: new Set(),
    import: new Set(['import_statement', 'import_from_statement']),
    branch: new Set(PY_BRANCH_KINDS),
    cognitiveBranch: new Set(PY_COGNITIVE_BRANCH_KINDS),
    nesting: new Set(PY_NESTING_KINDS),
    ternary: new Set(['conditional_expression']),
    catchClause: new Set(['except_clause']),
    call: new Set(['call']),
    string: new Set(['string']),
    comment: new Set(['comment']),
    importSourceField: 'name',
  };
}
