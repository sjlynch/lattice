# projectState helpers

Small private helpers for `ProjectStateManager` only.

- `diskPersistence.ts` owns JSON load/write, atomic persistence, and corrupt-file preservation/no-clobber guards.
- `listLookup.ts` owns list-backed cross-project item lookup utilities used by task/workflow stores.

Keep `backend/src/projectStateManager.ts` as the public import surface; do not make callers import these helpers directly unless the base manager is being refactored again.
