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
  // Branch nodes for cyclomatic complexity (+1 each)
  branch: Set<string>;
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
const PY_NESTING_KINDS = [
  'if_statement',
  'elif_clause',
  'for_statement',
  'while_statement',
  'try_statement',
  'with_statement',
  'conditional_expression',
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
      nesting: new Set(PY_NESTING_KINDS),
      ternary: new Set(['conditional_expression']),
      catchClause: new Set(['except_clause']),
      call: new Set(['call']),
      string: new Set(['string']),
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
