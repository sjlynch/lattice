// MCP resolver policy: the enable/scope decisions the resolver makes for a given
// spawn. Kept separate from Claude config *shaping* (`claudeServerConfig.ts`) and
// from catalog merge / orchestration (`registry.ts`). Pure — no I/O.

import type { UserSettings } from '../userSettings.js';

// Whether Playwright is on for this resolve, and (if so) whether it runs
// headless. Two independent switches feed it, matching the two UI surfaces:
//   - `mcpOverrides.playwright` (Settings → MCP tab): GLOBAL. Injected into
//     every Lattice-spawned Claude session for the project AND the project-root
//     entry that the user's own root-cwd `claude` sessions read. Always headless
//     (these are background / unattended sessions — nobody is watching them).
//   - `qaPlaywright` (QA lane): QA-RUNS-ONLY — applies only when `isQaRun`. Its
//     `headless` flag is the "I want to watch it test" control (default headless).
// When both apply (a QA run with the global toggle also on), the QA headless
// toggle wins so the QA lane's eye switch stays authoritative for QA runs.
export function resolvePlaywright(
  settings: Pick<UserSettings, 'mcpOverrides' | 'qaPlaywright'>,
  isQaRun: boolean,
): { enabled: boolean; headless: boolean } {
  const qa = settings.qaPlaywright;
  if (isQaRun && qa?.enabled === true) {
    return { enabled: true, headless: qa.headless !== false };
  }
  if (settings.mcpOverrides?.playwright === true) {
    return { enabled: true, headless: true };
  }
  return { enabled: false, headless: true };
}
