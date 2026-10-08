# backend/src/shared — code both packages import

Logic and types the backend and the frontend must agree on, written ONCE.
The frontend imports these files by relative path
(`../../backend/src/shared/harnesses`); Vite bundles them and `tsc -b` checks
them. Before this folder each pair was hand-copied and kept "in lockstep" by
comments, and several had drifted.

## Rules

- **Relative imports only** — no `node:` builtins, no npm packages, anywhere in
  the graph reachable from here (including what `wireTypes.ts` re-exports).
  Pinned by `__tests__/sharedFolderBoundary.test.ts`.
- Must also compile under the frontend's stricter flags (`verbatimModuleSyntax`,
  `erasableSyntaxOnly`, `noUnusedLocals`): `import type` for types, no enums or
  parameter properties.
- A shared module the terminal-server reaches (today `harnesses.ts`, via
  `../harnesses.ts`) must be listed in `../terminalFingerprint.ts`.
- Something both sides need → put it here rather than copying it.

## Modules

- `harnesses.ts` — `AgentHarness` vocabulary + `PI_MODEL_PATTERN_RE` /
  `isPiModelPattern` (the `pi --model` shell-injection guard).
- `searchPattern.ts` — `wildcardRegexSource`: search query → regex source
  (graph filename pass and backend content search / ripgrep).
- `workflowVariables.ts` — the `{{name}}` grammar, `normalizeVariableName`,
  `USER_INSTRUCTIONS_VAR`.
- `terminalLabels.ts` — `shortLabel` for terminal tabs.
- `wireTypes.ts` — type-only re-exports of wire types (`Task`, `TerminalRecord`
  family) that `frontend/src/api/types/*` re-export instead of redeclaring.
  Other `frontend/src/api/types/*` files are still hand-maintained mirrors;
  move a type here when you touch it (its backend module must be node-free —
  e.g. `McpSpawnScope` moved to `../mcp/spawnScope.ts` for this).
