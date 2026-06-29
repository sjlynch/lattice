# frontend/src/components/workflows/prompts

Raw markdown bodies for built-in workflow quick-add prompts.

- Prompt metadata lives in `../defaultPrompts.ts`; these files are the bodies
  imported with Vite's raw asset handling.
- Keep bytes stable when refactoring components — changing a prompt changes the
  user's generated workflow step text.
- Project-aware variants are generated in `../promptTemplates.ts` and
  `../projectStackDetection.ts`; do not duplicate stack-detection logic in the
  markdown files.
- `{{user_instructions}}` injection is handled by `promptVariables.ts` /
  `withUserInstructions`, not by manually appending it here unless the template
  explicitly needs different placement.
