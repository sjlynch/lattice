# frontend/src/api/types

Domain-split TypeScript types for backend payloads. `index.ts` re-exports this
folder, and `../types.ts` is the legacy compatibility shim.

- Keep request/response shapes close to the API module that consumes them
  (`tasks`, `workflows`, `runs`, `settings`, etc.).
- Prefer explicit string unions that mirror backend types over loose `string`
  when the UI branches on values.
- Do not put fetch helpers here; runtime calls belong in `frontend/src/api/*.ts`.
- When adding a type file, export it from `types/index.ts` and ensure
  `frontend/src/api/CLAUDE.md`'s module list remains accurate if the domain is
  new.
