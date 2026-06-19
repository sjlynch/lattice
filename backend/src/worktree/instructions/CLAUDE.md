# backend/src/worktree/instructions

Renders the in-worktree instruction markdown an agent reads (`LATTICE_TASK.md`
for a fresh task, `MERGE_INSTRUCTIONS.md` / `STASH_CONFLICT_*.md` for a
conflict resolver) and repairs the Claude Stop hook before a resolver spawns.
`../instructions.ts` re-exports the public surface.

The `LATTICE_TASK.md` and `MERGE_INSTRUCTIONS.md` bodies are now **editable
templates**: their default markdown + `{{token}}` set live in
`../../instructionTemplates/defs.ts`, and `renderTaskMarkdown` /
`renderMergeInstructions` take the resolved (override-or-default) template as
their last argument and `applyTemplate` the computed token values. The spawn
caller does the `resolveInstructionTemplate(project, id)`. See
`backend/src/instructionTemplates/CLAUDE.md`.

## Modules

- `taskPrompt.ts` — `renderTaskMarkdown(task, backendOrigin, harness, envNotes,
  deadCode)`: builds the `LATTICE_TASK.md` body. **Returns the string** — the
  caller (`worktree/setup/setupFiles.ts`) writes it into the worktree root.
  Prepends the env-notes blockquote, then an optional dead-code block.
- `mergePrompt.ts` — `writeMergeInstructions(...)`: **writes**
  `MERGE_INSTRUCTIONS.md` *inside the worktree* (the resolver Claude runs with
  `cwd = worktreePath`) and returns its path.
- `stashPrompt.ts` — `writeStashResolveInstructions` (per-task) +
  `writeRunStashResolveInstructions` (per merge-run): **write**
  `STASH_CONFLICT_*.md` at the *repo root*, not the worktree — a stash/snapshot
  pop conflicts against main's working tree, so that's where the resolver works.
- `stopHookRepair.ts` — `ensureValidStopHook`: validates/repairs the worktree's
  `.claude/settings.local.json` from Lattice's template if it's missing or
  unparseable. Called by `writeMergeInstructions` *before* the UI spawns the
  resolver.
- `shared.ts` — conflict-marker constants, file-list hints, stash-drop steps,
  the checkout-theirs footer, and `renderEnvBlockFor`. Centralised so the prose
  duplicated across the three rendered files stays in lockstep.

## Gotchas

- **`renderTaskMarkdown` doesn't write; the others do.** Don't add a write to
  `taskPrompt.ts` — `setupFiles.ts` owns where `LATTICE_TASK.md` lands.
- **The resolver is always Claude**, even for a task originally run by Pi/Codex
  — that's why a valid Stop hook (and `ensureValidStopHook`) matters regardless
  of the task's harness. If merge-conflict markers land in
  `settings.local.json`, Claude's parser errors at bootstrap before it ever
  reads the merge instructions, so the repair is a hard prerequisite.
- **`harness` reshapes `LATTICE_TASK.md`.** Claude (default) ends the session
  and its Stop hook POSTs `/complete`. Pi/Codex have no command-hook
  mechanism, so the markdown gains an autonomy preamble and a stronger final
  step instructing the model to `curl` `/complete` itself.
- **Injections are gated.** The env-notes block only renders when a package
  manager is detected; the dead-code block only when `deadCode.total > 0`, and
  is framed as optional context so an unrelated task isn't derailed into a
  cleanup hunt.
