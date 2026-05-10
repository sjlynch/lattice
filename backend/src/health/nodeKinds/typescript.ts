import type { GrammarKey } from '../parser.js';
import type { NodeKinds } from './index.js';

const TS_FUNCTION_KINDS = [
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'function',
];

const TS_NAMED_FUNCTION_KINDS = [
  'function_declaration',
  'method_definition',
  'generator_function_declaration',
];

const TS_CLASS_KINDS = ['class_declaration', 'class', 'class_expression'];

const TS_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_case',
  'switch_default',
  'catch_clause',
  'ternary_expression',
];

// Cognitive flavor: switch_statement (the dispatch itself) replaces
// the per-case entries from TS_BRANCH_KINDS. See the comment on
// NodeKinds.cognitiveBranch above for the rationale.
const TS_COGNITIVE_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'catch_clause',
  'ternary_expression',
];

const TS_NESTING_KINDS = [
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
  'catch_clause',
  'ternary_expression',
];

const TS_CALL_KINDS = ['call_expression', 'new_expression'];

const TS_STRING_KINDS = ['string', 'template_string'];

export function buildTsLikeNodeKinds(grammar: GrammarKey): NodeKinds {
  // typescript / tsx / javascript share a near-identical set; the only
  // grammar-specific bit is `interface_declaration`, which isn't part
  // of plain JavaScript.
  const isTs = grammar === 'typescript' || grammar === 'tsx';
  return {
    function: new Set(TS_FUNCTION_KINDS),
    namedFunction: new Set(TS_NAMED_FUNCTION_KINDS),
    anonymousFunction: new Set(['function_expression', 'arrow_function']),
    class: new Set(TS_CLASS_KINDS),
    interface: new Set(isTs ? ['interface_declaration'] : []),
    import: new Set(['import_statement']),
    branch: new Set(TS_BRANCH_KINDS),
    cognitiveBranch: new Set(TS_COGNITIVE_BRANCH_KINDS),
    nesting: new Set(TS_NESTING_KINDS),
    ternary: new Set(['ternary_expression']),
    catchClause: new Set(['catch_clause']),
    call: new Set(TS_CALL_KINDS),
    string: new Set(TS_STRING_KINDS),
    comment: new Set(['comment']),
    importSourceField: 'source',
  };
}
