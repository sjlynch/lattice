# frontend/src/components/workflows/prompts

Raw markdown bodies for built-in workflow quick-add prompts.

- Prompt metadata lives in `../defaultPrompts.ts`; these files are the bodies
  imported with Vite's raw asset handling. A chip may also carry `tools`
  (`opengrep.md` → `tools: ['opengrep']`): the seeded step then runs that
  pre-run tool before its harness spawns, and the body is written against the
  report the tool leaves beside the brief (`OPENGREP_FINDINGS.md`). The
  "Security review (Opengrep)" template in `src/workflowTemplates.ts` imports
  the same body, so there is one copy to keep planner-only.
- **Every prompt here must be planner-only.** A workflow step runs under
  `WORKFLOW_STEP.md`, which forbids editing project files or committing — the
  step's only output is Lattice task-board entries. A prompt that says "do the
  work" or "commit your work" puts the agent in front of two contradictory
  instructions; one resolved that by committing docs straight to the repo
  (2026-08). Phrase every prompt as *file tasks for* the work.
- Keep bytes stable when refactoring components — changing a prompt changes the
  user's generated workflow step text.
- **Rewording a prompt is a two-file change.** Saved workflows hold a copy of
  the old text, so also append the old body to that prompt's entry in
  `backend/src/workflows/defaultPromptMigrations.ts` and update its `current`.
  `backend/src/__tests__/defaultPromptMigrations.test.ts` fails if the two
  copies drift.
- The opening sentence is a matcher key: `../promptTemplates.ts` identifies a
  saved step by `startsWith` on it. Changing the opener means adding the new
  opener there (keep the old one too).
- Project-aware variants are generated in `../promptTemplates.ts` and
  `../projectStackDetection.ts`; do not duplicate stack-detection logic in the
  markdown files.
- `{{user_instructions}}` injection is handled by `promptVariables.ts` /
  `withUserInstructions`, not by manually appending it here unless the template
  explicitly needs different placement.
