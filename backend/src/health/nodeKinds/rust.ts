import type { NodeKinds } from './index.js';

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
  return {
    function: new Set(RUST_FUNCTION_KINDS),
    namedFunction: new Set(['function_item']),
    anonymousFunction: new Set(['closure_expression']),
    class: new Set(['struct_item', 'enum_item']),
    interface: new Set(['trait_item']),
    import: new Set(),
    branch: new Set(RUST_BRANCH_KINDS),
    cognitiveBranch: new Set(RUST_COGNITIVE_BRANCH_KINDS),
    nesting: new Set(RUST_NESTING_KINDS),
    ternary: new Set(),
    catchClause: new Set(),
    call: new Set(['call_expression', 'macro_invocation']),
    string: new Set(['string_literal', 'raw_string_literal']),
    comment: new Set(['line_comment', 'block_comment']),
    importSourceField: 'path',
  };
}
