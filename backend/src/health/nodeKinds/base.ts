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

export type NodeKindSets = {
  functionKinds: readonly string[];
  namedFunctionKinds?: readonly string[];
  anonymousFunctionKinds?: readonly string[];
  classKinds?: readonly string[];
  interfaceKinds?: readonly string[];
  importKinds?: readonly string[];
  branchKinds: readonly string[];
  cognitiveBranchKinds?: readonly string[];
  nestingKinds: readonly string[];
  ternaryKinds?: readonly string[];
  catchClauseKinds?: readonly string[];
  callKinds: readonly string[];
  stringKinds?: readonly string[];
  commentKinds?: readonly string[];
  importSourceField: string;
};

export function buildNodeKinds({
  functionKinds,
  namedFunctionKinds = [],
  anonymousFunctionKinds = [],
  classKinds = [],
  interfaceKinds = [],
  importKinds = [],
  branchKinds,
  cognitiveBranchKinds = branchKinds,
  nestingKinds,
  ternaryKinds = [],
  catchClauseKinds = [],
  callKinds,
  stringKinds = [],
  commentKinds = [],
  importSourceField,
}: NodeKindSets): NodeKinds {
  return {
    function: new Set(functionKinds),
    namedFunction: new Set(namedFunctionKinds),
    anonymousFunction: new Set(anonymousFunctionKinds),
    class: new Set(classKinds),
    interface: new Set(interfaceKinds),
    import: new Set(importKinds),
    branch: new Set(branchKinds),
    cognitiveBranch: new Set(cognitiveBranchKinds),
    nesting: new Set(nestingKinds),
    ternary: new Set(ternaryKinds),
    catchClause: new Set(catchClauseKinds),
    call: new Set(callKinds),
    string: new Set(stringKinds),
    comment: new Set(commentKinds),
    importSourceField,
  };
}
