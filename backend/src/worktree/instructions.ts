// Public surface for the instruction-writer subsystem. The actual
// rendering lives in `instructions/`:
//   - LATTICE_TASK.md         — initial task brief written into a fresh worktree (taskPrompt.ts)
//   - MERGE_INSTRUCTIONS.md   — written into a worktree after a merge conflict (mergePrompt.ts)
//   - STASH_CONFLICT_*.md     — written into the main repo after a stash-pop conflict (stashPrompt.ts)
// `instructions/shared.ts` holds the shared snippets and the env-block
// helper; `instructions/stopHookRepair.ts` keeps the Stop-hook JSON
// repair logic close to the writers that depend on it.

export { renderTaskMarkdown } from './instructions/taskPrompt.js';
export { writeMergeInstructions } from './instructions/mergePrompt.js';
export {
  writeStashResolveInstructions,
  writeRunStashResolveInstructions,
} from './instructions/stashPrompt.js';
