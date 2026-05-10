import { buildNodeKinds, type NodeKinds } from './base.js';

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
  return buildNodeKinds({
    functionKinds: PY_FUNCTION_KINDS,
    namedFunctionKinds: PY_NAMED_FUNCTION_KINDS,
    anonymousFunctionKinds: ['lambda'],
    classKinds: ['class_definition'],
    importKinds: ['import_statement', 'import_from_statement'],
    branchKinds: PY_BRANCH_KINDS,
    cognitiveBranchKinds: PY_COGNITIVE_BRANCH_KINDS,
    nestingKinds: PY_NESTING_KINDS,
    ternaryKinds: ['conditional_expression'],
    catchClauseKinds: ['except_clause'],
    callKinds: ['call'],
    stringKinds: ['string'],
    commentKinds: ['comment'],
    importSourceField: 'name',
  });
}
