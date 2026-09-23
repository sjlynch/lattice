import { getUserSettings } from './storage.js';

// Whether Claude's auto-memory should be OFF for this project. Default is
// disabled (memory off) — an absent setting counts as `true`, matching the
// opt-out model used by instrumentProjectClaudeSessions. Read at every Claude
// spawn (terminal-server POST /sessions) and on project open / settings save
// (the project-instrumentation route).
export async function isClaudeMemoryDisabled(
  projectPath: string,
): Promise<boolean> {
  const settings = await getUserSettings(projectPath);
  return settings.disableClaudeMemory !== false;
}

// Whether the post-merge hook is enabled for this project. The hook still
// also requires a non-empty `postMergeHookPrompt` to fire (see trigger.ts);
// this is the master on/off switch that lets a user pause it without clearing
// the prompt. Default is ON (memory of an existing prompt keeps working) — an
// absent setting counts as `true`; only an explicit `false` disables.
export async function isPostMergeHookEnabled(
  projectPath: string,
): Promise<boolean> {
  const settings = await getUserSettings(projectPath);
  return settings.postMergeHookEnabled !== false;
}

// Whether Codex should be launched with `--yolo` for this project (its
// analogue of Claude's `--dangerously-skip-permissions`). Default is ON — an
// absent setting counts as `true`; only an explicit `false` runs plain `codex`.
// Read at every Codex spawn (task run/resume, workflow step, post-merge hook,
// prompt customization) to decide whether to append the flag.
export async function isCodexYoloEnabled(
  projectPath: string,
): Promise<boolean> {
  const settings = await getUserSettings(projectPath);
  return settings.codexYolo !== false;
}

// Whether a finished workflow agent step's terminal stays open (its pty left
// running) instead of being killed on advance. Default off.
export async function isKeepWorkflowStepTerminalsEnabled(
  projectPath: string,
): Promise<boolean> {
  const settings = await getUserSettings(projectPath);
  return settings.keepWorkflowStepTerminals === true;
}

// Whether a QA-lane e2e (Playwright) terminal should AUTO-CLOSE when its run
// finishes. Default is "stay open" (absent/false) so the user can read the
// PASS/FAIL verdict and output; only an explicit `true` opts into auto-close.
// Read by the QA-run `/done` callback to decide whether to tear the pty down.
export async function isQaTerminalAutoCloseEnabled(
  projectPath: string,
): Promise<boolean> {
  const settings = await getUserSettings(projectPath);
  return settings.qaTerminalAutoClose === true;
}
