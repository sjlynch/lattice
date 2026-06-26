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
