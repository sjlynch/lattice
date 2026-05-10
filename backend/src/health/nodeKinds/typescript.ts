import type { GrammarKey } from '../parser.js';
import { buildNodeKinds, type NodeKinds } from './base.js';

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
  return buildNodeKinds({
    functionKinds: TS_FUNCTION_KINDS,
    namedFunctionKinds: TS_NAMED_FUNCTION_KINDS,
    anonymousFunctionKinds: ['function_expression', 'arrow_function'],
    classKinds: TS_CLASS_KINDS,
    interfaceKinds: isTs ? ['interface_declaration'] : [],
    importKinds: ['import_statement'],
    branchKinds: TS_BRANCH_KINDS,
    cognitiveBranchKinds: TS_COGNITIVE_BRANCH_KINDS,
    nestingKinds: TS_NESTING_KINDS,
    ternaryKinds: ['ternary_expression'],
    catchClauseKinds: ['catch_clause'],
    callKinds: TS_CALL_KINDS,
    stringKinds: TS_STRING_KINDS,
    commentKinds: ['comment'],
    importSourceField: 'source',
  });
}
