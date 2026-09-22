# backend/src/workflowPromptCustomizations

Prompt-customization session implementation behind the public `workflowPromptCustomizations.ts` shim.

- `index.ts` — public service functions: `start`/`get`/`complete` customization requests while preserving route-facing exports. `start` is a thin orchestrator that composes the helpers below (normalize → materialize scratch → install backstops → resolve command → store → spawn); `complete` owns the registry mutation for the /complete callback.
- `types.ts` — request/status/template input and response types.
- `registry.ts` — in-memory request registry plus clone helpers for route-safe snapshots. Pruned on every store to the newest `MAX_FINISHED_CUSTOMIZATIONS` (20) finished requests — the frontend polls one id only until it reaches a terminal status, so older finished records have no reader; running requests are never pruned.
- `paths.ts` — scratch-file paths under `<project>/.lattice/workflow-prompt-customizations/<id>/`.
- `requestNormalizer.ts` — validate the raw start input and build a fresh `running` record (id/cwd/harness/prompt). The only place that throws the route's `project required` / `prompt or customization instructions required` errors.
- `scratchFiles.ts` — `materializeCustomizationScratch`: mkdir the cwd and write the model-facing files (`submit-customized-prompt.cjs` + `CUSTOMIZE_PROMPT.md`).
- `backstops.ts` — `installCustomizationBackstops`: write `lattice-customization-backstop.cjs` + install the Claude Stop hook, Pi completion extension, and pi-subagents shim. Always installs both harness backstops (the unused one is inert); see the comment there for why an empty curl won't do.
- `instructionRenderer.ts` — `CUSTOMIZE_PROMPT.md` contents handed to the selected harness.
- `submitScriptRenderer.ts` — `submit-customized-prompt.cjs` callback helper.
- `backstopScripts.ts` — `lattice-customization-backstop.cjs` body (Claude Stop-hook fail-soft callback).
- `sessionStarter.ts` — harness command selection (`resolveCustomizationCommand` resolves the Pi model + builds the launch command) and terminal pre-spawn. A non-CAP `{error}` from the queued spawn (CAP is retried inside the queue) marks the record `errored` with that message; `start` does the same for a *thrown* pre-spawn before rethrowing. Left `running` with no `serverId`, the frontend polled it for its whole budget.

Keep scratch location, command/cwd/serverId response semantics, and completion error behavior stable because the frontend polls this shape directly.
