import path from 'node:path';
import { buildAgentCommand } from '../agentCommandBuilder.js';
import type { AgentHarness } from '../harnesses.js';

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
  codexYolo?: boolean;
}): string {
  const { harness, instructionsFile, piModel, codexYolo } = args;
  const fileName = path.basename(instructionsFile);

  if (harness === 'codex') {
    // Codex now has a Stop-hook backstop (a `.codex/hooks.json` Stop hook that
    // POSTs /complete on turn completion — see codexStopHook.ts), but still
    // emphasise the explicit callback so the merge gate advances promptly and
    // survives a hook that doesn't fire (belt-and-suspenders, like Pi).
    return buildAgentCommand({
      harness,
      codexYolo,
      prompt: `Please read ${fileName} in this directory and complete the post-merge hook task it describes. You MUST curl the completion URL from the brief before exiting — the merge run is blocked waiting for your callback.`,
    });
  }

  return buildAgentCommand({
    harness,
    piModel,
    prompt: `Please read ${fileName} in this directory and complete the post-merge hook task it describes. Follow the completion instructions at the end carefully — Lattice is blocking the merge step waiting for your callback.`,
  });
}

export const POST_MERGE_HOOK_FILENAME = 'POST_MERGE_HOOK.md';

export function instructionsFilePath(scratchDir: string): string {
  return path.join(scratchDir, POST_MERGE_HOOK_FILENAME);
}
