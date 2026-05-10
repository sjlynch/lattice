// ---- Tier-2 grammars ----
//
// All five share the same pattern: classic C-style control flow
// (if/for/while/do/switch) maps directly to tree-sitter node names
// modeled on the JS family. Switch dispatch lives on the
// switch-statement node (per Sonar's cognitive spec), individual
// cases are CC-only.
//
// We deliberately register an empty `import` set on these grammars.
// Their imports are resolved against language-specific module
// systems (Go's GOPATH/modules, Rust's crate graph, the JVM
// classpath) that we don't model — registering the import nodes
// would just produce thousands of unresolved specs that pollute
// fan-out without adding any signal.

import type { NodeKinds } from './index.js';

const GO_FUNCTION_KINDS = ['function_declaration', 'method_declaration', 'func_literal'];
const GO_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'expression_case',
  'default_case',
  'type_case',
  'communication_case',
];
const GO_COGNITIVE_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'type_switch_statement',
  'select_statement',
];
const GO_NESTING_KINDS = GO_COGNITIVE_BRANCH_KINDS;

export function buildGoNodeKinds(): NodeKinds {
  return {
    function: new Set(GO_FUNCTION_KINDS),
    namedFunction: new Set(['function_declaration', 'method_declaration']),
    anonymousFunction: new Set(['func_literal']),
    class: new Set(),
    interface: new Set(),
    import: new Set(),
    branch: new Set(GO_BRANCH_KINDS),
    cognitiveBranch: new Set(GO_COGNITIVE_BRANCH_KINDS),
    nesting: new Set(GO_NESTING_KINDS),
    ternary: new Set(),
    catchClause: new Set(),
    call: new Set(['call_expression']),
    string: new Set(['interpreted_string_literal', 'raw_string_literal']),
    comment: new Set(['comment']),
    importSourceField: 'path',
  };
}
