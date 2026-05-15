# backend/src/health/walker

Split implementation behind the `../walker.ts` shim. Keep the traversal a
single recursive AST pass unless a metric truly needs a second pass.

- `index.ts` — `analyzeTree` dispatch: walks the tree, collects file-level
  imports/classes/string literals/smell counters, and pushes per-function
  records onto a stack.
- `functionRecord.ts` — builds `FnRecord` (lines, async/docstring, initial
  complexity, call set) and parameter-derived smells; re-exports the stable
  helper API for callers that imported from this file before the split.
- `functionNames.ts` — cross-language name recovery (generic `name` field,
  TS/JS variable/object/member/field/assignment parents, Python identifier
  fallback).
- `parameters.ts` — parameter counting plus TS/Python boolean-parameter and
  Python mutable-default detection.
- `docstrings.ts` — Python function docstring detection.
- `complexity.ts` — cyclomatic + cognitive increments. SonarSource B1
  cognitive-complexity is the contract, especially else-if and short-circuit
  operator handling.
- `depth.ts` — optional-chain and ternary depth helpers used by smell checks.
- `smells.ts` — AST-driven smell detection split into TS/JS, Python, and
  generic structural detectors, plus helpers for import strings, console-noise
  calls, mixed exports, and call leaf names.

Add language shape in `../nodeKinds/` first; only special-case here when node
semantics differ beyond the shared kind sets.
