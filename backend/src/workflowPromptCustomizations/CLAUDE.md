# backend/src/workflowPromptCustomizations

Prompt-customization session implementation behind the public `workflowPromptCustomizations.ts` shim.

- `index.ts` — public service functions: start/get/complete customization requests while preserving route-facing exports.
- `types.ts` — request/status/template input and response types.
- `registry.ts` — in-memory request registry plus clone helpers for route-safe snapshots.
- `paths.ts` — scratch-file paths under `<project>/.lattice/workflow-prompt-customizations/<id>/`.
- `instructionRenderer.ts` — `CUSTOMIZE_PROMPT.md` contents handed to the selected harness.
- `submitScriptRenderer.ts` — `submit-customized-prompt.cjs` callback helper.
- `sessionStarter.ts` — harness command selection and terminal pre-spawn.

Keep scratch location, command/cwd/serverId response semantics, and completion error behavior stable because the frontend polls this shape directly.
