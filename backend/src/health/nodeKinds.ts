// Per-language tables that map our generic categories ("this is a
// function", "this is a branch") to the actual node type strings used
// by each tree-sitter grammar. The metrics walker stays
// language-agnostic — it asks `isFunction(node, lang)` etc. rather
// than embedding grammar-specific node names directly.

import type { GrammarKey } from './parser.js';

export type NodeKinds = {
  // Function-like nodes (anything we treat as its own scope)
  function: Set<string>;
  // Named declarations only — used for the `high_function_count`
  // smell threshold so files full of inline arrow callbacks don't
  // flag falsely
  namedFunction: Set<string>;
  // Anonymous function-likes — tracked separately for the call graph
  // and own-body length calculation
  anonymousFunction: Set<string>;
  // Class-like
  class: Set<string>;
  // Interface (TS/TSX only) — empty in other grammars
  interface: Set<string>;
  // Import statement nodes
  import: Set<string>;
  // Nodes that contribute +1 to cyclomatic complexity (McCabe). One
  // per distinct independent path, so each switch case counts.
  branch: Set<string>;
  // Nodes that contribute +1+nesting to cognitive complexity (Sonar
  // B1). Diverges from `branch` on switch: the switch_statement
  // itself dispatches once with the nesting penalty; individual
  // switch_case / switch_default labels do NOT add cognitive load
  // because Sonar treats them as continuations, not new decisions.
  // Treating each case as +1+nesting (the previous behavior) made
  // dispatch tables look 5–10× more cognitively complex than they
  // really are, blowing past the high_cognitive_complexity threshold
  // for routine code.
  cognitiveBranch: Set<string>;
  // Subset of branches that introduce nesting depth
  nesting: Set<string>;
  // Ternary expression node (counted as a branch and as a smell when
  // chained 3+ deep)
  ternary: Set<string>;
  // Catch clause / except clause
  catchClause: Set<string>;
  // Call expression node
  call: Set<string>;
  // String literal nodes (template/regular)
  string: Set<string>;
  // Comment node
  comment: Set<string>;
  // Field name on an import statement holding the source string
  importSourceField: string;
};

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
const JAVA_COGNITIVE_BRANCH_KINDS = [
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
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
  'switch_expression',
  'try_statement',
  'catch_clause',
  'ternary_expression',
];

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

// Ruby uses different node names than the C-family grammars: `if`,
// `unless`, `while`, `until`, `case`, `when`, `rescue`. Method
// definitions are `method` / `singleton_method`; blocks are `do_block`
// or brace-style `block`. Ruby has no ternary node — `?:` parses as
// a conditional expression but is rarely idiomatic; skip it.
const RUBY_FUNCTION_KINDS = [
  'method',
  'singleton_method',
  'lambda',
  'do_block',
  'block',
];
const RUBY_NAMED_FUNCTION_KINDS = ['method', 'singleton_method'];
const RUBY_ANONYMOUS_FUNCTION_KINDS = ['lambda', 'do_block', 'block'];
const RUBY_BRANCH_KINDS = [
  'if',
  'elsif',
  'unless',
  'while',
  'until',
  'for',
  'when',
  'rescue',
  'conditional',
];
const RUBY_COGNITIVE_BRANCH_KINDS = [
  'if',
  'unless',
  'while',
  'until',
  'for',
  'case',
  'rescue',
  'conditional',
];
const RUBY_NESTING_KINDS = [
  'if',
  'unless',
  'while',
  'until',
  'for',
  'case',
  'begin',
  'rescue',
  'conditional',
];

function buildNodeKinds(grammar: GrammarKey): NodeKinds {
  if (grammar === 'python') {
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
  if (grammar === 'go') {
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
  if (grammar === 'rust') {
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
  if (grammar === 'java') {
    return {
      function: new Set(JAVA_FUNCTION_KINDS),
      namedFunction: new Set(['method_declaration', 'constructor_declaration']),
      anonymousFunction: new Set(['lambda_expression']),
      class: new Set(['class_declaration', 'enum_declaration', 'record_declaration']),
      interface: new Set(['interface_declaration']),
      import: new Set(),
      branch: new Set(JAVA_BRANCH_KINDS),
      cognitiveBranch: new Set(JAVA_COGNITIVE_BRANCH_KINDS),
      nesting: new Set(JAVA_NESTING_KINDS),
      ternary: new Set(['ternary_expression']),
      catchClause: new Set(['catch_clause']),
      call: new Set(['method_invocation', 'object_creation_expression']),
      string: new Set(['string_literal']),
      comment: new Set(['line_comment', 'block_comment']),
      importSourceField: 'name',
    };
  }
  if (grammar === 'csharp') {
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
  if (grammar === 'ruby') {
    return {
      function: new Set(RUBY_FUNCTION_KINDS),
      namedFunction: new Set(RUBY_NAMED_FUNCTION_KINDS),
      anonymousFunction: new Set(RUBY_ANONYMOUS_FUNCTION_KINDS),
      class: new Set(['class', 'module']),
      interface: new Set(),
      import: new Set(),
      branch: new Set(RUBY_BRANCH_KINDS),
      cognitiveBranch: new Set(RUBY_COGNITIVE_BRANCH_KINDS),
      nesting: new Set(RUBY_NESTING_KINDS),
      ternary: new Set(['conditional']),
      catchClause: new Set(['rescue']),
      call: new Set(['call', 'command', 'command_call', 'method_call']),
      string: new Set(['string', 'heredoc_body']),
      comment: new Set(['comment']),
      importSourceField: 'name',
    };
  }
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

const cache = new Map<GrammarKey, NodeKinds>();

export function nodeKindsFor(grammar: GrammarKey): NodeKinds {
  let nk = cache.get(grammar);
  if (!nk) {
    nk = buildNodeKinds(grammar);
    cache.set(grammar, nk);
  }
  return nk;
}
