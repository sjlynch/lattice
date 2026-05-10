import { buildNodeKinds, type NodeKinds } from './base.js';

const RUST_FUNCTION_KINDS = ['function_item', 'closure_expression'];
const RUST_BRANCH_KINDS = [
  'if_expression',
  'while_expression',
  'for_expression',
  'loop_expression',
  'match_arm',
  'if_let_expression',
  'while_let_expression',
];
const RUST_COGNITIVE_BRANCH_KINDS = [
  'if_expression',
  'while_expression',
  'for_expression',
  'loop_expression',
  'match_expression',
  'if_let_expression',
  'while_let_expression',
];
const RUST_NESTING_KINDS = RUST_COGNITIVE_BRANCH_KINDS;

export function buildRustNodeKinds(): NodeKinds {
  return buildNodeKinds({
    functionKinds: RUST_FUNCTION_KINDS,
    namedFunctionKinds: ['function_item'],
    anonymousFunctionKinds: ['closure_expression'],
    classKinds: ['struct_item', 'enum_item'],
    interfaceKinds: ['trait_item'],
    branchKinds: RUST_BRANCH_KINDS,
    cognitiveBranchKinds: RUST_COGNITIVE_BRANCH_KINDS,
    nestingKinds: RUST_NESTING_KINDS,
    callKinds: ['call_expression', 'macro_invocation'],
    stringKinds: ['string_literal', 'raw_string_literal'],
    commentKinds: ['line_comment', 'block_comment'],
    importSourceField: 'path',
  });
}
