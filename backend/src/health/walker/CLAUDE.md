# backend/src/health/walker

Split implementation behind the `../walker.ts` shim. Keep the traversal a
single recursive AST pass unless a metric truly needs a second pass.

- `index.ts` — `analyzeTree` dispatch: walks the tree, collects file-level
  imports/classes/string literals/smell counters, and pushes per-function
  records onto a stack.
- `functionRecord.ts` — builds `FnRecord` (name, params, lines, async/docstring,
  initial complexity, call set) and parameter-derived smells.
- `complexity.ts` — cyclomatic + cognitive increments. SonarSource B1
  cognitive-complexity is the contract, especially else-if and short-circuit
  operator handling.
- `depth.ts` — optional-chain and ternary depth helpers used by smell checks.
- `smells.ts` — AST-driven smell detection plus helpers for import strings,
  console-noise calls, mixed exports, and call leaf names.

Add language shape in `../nodeKinds/` first; only special-case here when node
semantics differ beyond the shared kind sets.
