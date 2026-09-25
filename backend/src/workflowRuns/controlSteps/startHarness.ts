// Harness / Pi-model resolution for the 'start' control step (re-exported from
// start.ts, which is where callers and tests import it from).

import { normalizeAgentHarness, type AgentHarness } from '../../harnesses.js';
import { normalizePiModel } from '../../piModels.js';
import { getUserSettings } from '../../userSettings.js';
import type { WorkflowRun } from '../state.js';

// The Pi model the Start step's spawned task agents should use FOR A RUN-LEVEL
// OVERRIDE. Mirrors the run-level harness resolution and `effectiveStepPiModel`
// for regular workflow steps: the run's `piModelOverride` applies, but only
// when the run is a Pi run (Claude/codex ignore it, and a non-pi run must not
// pin a Pi model). Returns undefined otherwise so `startTaskById` falls back to
// the per-project default Pi model. Without this the Start step silently
// dropped the override and every spawned task ran on the project/default model.
// (The no-override case — the per-project DEFAULT harness/model — is resolved by
// `resolveStartStepHarnessPicker`.)
export function startStepTaskPiModel(
  run: Pick<WorkflowRun, 'harnessOverride' | 'piModelOverride'>,
): string | undefined {
  return normalizeAgentHarness(run.harnessOverride) === 'pi'
    ? run.piModelOverride
    : undefined;
}

export type StartStepTaskHarness = {
  harness: AgentHarness;
  piModel: string | undefined;
};

// Resolves the harness + Pi model the Start step should spawn each Open task on,
// mirroring the Task Board "Run All" path this step documents itself as matching:
//   - A run-level harness override pins EVERY spawned task to that harness (and,
//     for a Pi override, its `piModelOverride`) — the override case.
//   - With NO override, the per-project default applies — exactly like Run All,
//     which sends `UserSettings.harness` / `piModel` on each /run. `interleave`
//     is expanded the way the UI's `pickRunHarness` does: alternate claude/pi
//     across consecutive tasks (starting on claude), so a Start step over N Open
//     tasks produces the same claude/pi mix Run All would. Pi picks carry the
//     project's default Pi model; claude/codex picks never pin one.
// Resolving the per-project default ONCE (one settings read) returns a picker
// `(taskIndex) => {harness, piModel}`; `taskIndex` only matters for interleave.
//
// Without this the Start step hardcoded `normalizeAgentHarness(harnessOverride)`,
// which is `'claude'` whenever the run has no override (the common case) — so a
// project whose default harness is Pi/Codex got every workflow-started task
// silently forced onto Claude.
export async function resolveStartStepHarnessPicker(
  run: Pick<WorkflowRun, 'harnessOverride' | 'piModelOverride'>,
  projectPath: string,
): Promise<(taskIndex: number) => StartStepTaskHarness> {
  // Run-level override → pin every task to that harness + its Pi model override.
  if (run.harnessOverride) {
    const harness = normalizeAgentHarness(run.harnessOverride);
    const piModel = startStepTaskPiModel(run);
    return () => ({ harness, piModel });
  }
  // No override → the per-project default, read from UserSettings like Run All.
  const settings = await getUserSettings(projectPath);
  const piModel = normalizePiModel(settings.piModel);
  if (settings.harness === 'interleave') {
    return (taskIndex) => {
      const harness: AgentHarness = taskIndex % 2 === 0 ? 'claude' : 'pi';
      return { harness, piModel: harness === 'pi' ? piModel : undefined };
    };
  }
  const harness = normalizeAgentHarness(settings.harness);
  return () => ({ harness, piModel: harness === 'pi' ? piModel : undefined });
}
