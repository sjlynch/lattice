import path from 'node:path';
import type { AgentHarness } from '../harnesses.js';
import { buildPiModelFlag } from '../worktree/commands.js';

// Build the single-line shell command that launches the chosen harness for a
// post-merge hook. The pty's cwd is the home-scoped scratch dir (so the
// Stop hook in `<scratch>/.claude/settings.local.json` and the Pi
// `.pi/extensions/lattice-complete.ts` are actually picked up — both are
// loaded relative to cwd at session start). The agent then cds into the
// project as instructed by POST_MERGE_HOOK.md.
//
// This mirrors the push-run pattern: brief lives in the scratch dir,
// agent operates against the project repo via `cd`/absolute paths. The
// previous design ran the pty with cwd=projectPath and tried to pull
// settings in via `--add-dir` — but Claude does NOT read settings from
// --add-dir directories, only from cwd, so the Stop hook never fired and
// the merge run hung forever. Don't reintroduce that pattern.
export function buildPostMergeHookCommand(args: {
  harness: AgentHarness;
  instructionsFile: string;
  piModel?: string;
}): string {
  const { harness, instructionsFile, piModel } = args;
  const fileName = path.basename(instructionsFile);

  if (harness === 'claude') {
    return `claude --dangerously-skip-permissions "Please read ${fileName} in this directory and complete the post-merge hook task it describes. Follow the completion instructions at the end carefully — Lattice is blocking the merge step waiting for your callback."`;
  }
  if (harness === 'pi') {
    return `pi${buildPiModelFlag(piModel)} "Please read ${fileName} in this directory and complete the post-merge hook task it describes. Follow the completion instructions at the end carefully — Lattice is blocking the merge step waiting for your callback."`;
  }
  // Codex has no Stop-hook / shutdown-extension backstop, so emphasise the
  // explicit callback in the prompt.
  return `codex "Please read ${fileName} in this directory and complete the post-merge hook task it describes. You MUST curl the completion URL from the brief before exiting — Lattice has no Codex Stop-hook backstop and the merge run will hang otherwise."`;
}

export const POST_MERGE_HOOK_FILENAME = 'POST_MERGE_HOOK.md';

export function instructionsFilePath(scratchDir: string): string {
  return path.join(scratchDir, POST_MERGE_HOOK_FILENAME);
}
