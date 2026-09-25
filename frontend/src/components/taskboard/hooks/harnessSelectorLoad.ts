import type { UserSettings } from '../../../api';
import {
  isHarnessChoice,
  type HarnessAvailability,
  type HarnessChoice,
} from '../../../harnesses';

// A saved harness choice is "unavailable" when its CLI isn't installed, in which
// case we coerce back to `claude` so a run never targets a missing harness.
// `interleave` mixes in Pi, so it needs Pi too.
export function harnessUnavailable(
  harness: HarnessChoice,
  harnessAvail: HarnessAvailability,
): boolean {
  return (
    ((harness === 'pi' || harness === 'interleave') && !harnessAvail.pi) ||
    (harness === 'codex' && !harnessAvail.codex)
  );
}

export type HarnessSettingsLoadDeps = {
  fetchUserSettings: (folder: string) => Promise<UserSettings>;
  patchUserSettings: (
    folder: string,
    partial: Partial<UserSettings>,
  ) => Promise<unknown>;
  // True once a newer load — or a user pick in the dropdown — has superseded
  // this one. Evaluated AFTER the fetch resolves: on a fast project switch a
  // slow project-A response must not overwrite the just-selected project B's
  // harness/Pi state, nor persist a coerced `harness: claude` patch under the
  // wrong (now-inactive) folder; and a GET that began before the user's PATCH
  // must not revert the harness they just picked.
  isStale: () => boolean;
  setHarness: (harness: HarnessChoice) => void;
  setPiModel: (piModel: string | undefined) => void;
};

// The harness a project uses when it has none saved (or it can't be loaded).
export const DEFAULT_HARNESS: HarnessChoice = 'claude';

// Load the persisted harness + Pi model for `folder` and apply it through the
// provided setters — unless a newer load won the race, in which case the whole
// stale response is dropped. Every non-stale outcome sets the harness: a project
// with no (or an invalid) saved harness gets `claude`, and so does a failed load
// (`fetchUserSettings` should be the strict fetch so a failure throws rather
// than reading as `{}`). Leaving it untouched would keep the PREVIOUS project's
// choice, so Run All would spawn that project's harness here.
export async function loadHarnessForFolder(
  folder: string,
  harnessAvail: HarnessAvailability,
  deps: HarnessSettingsLoadDeps,
): Promise<void> {
  let settings: UserSettings;
  try {
    settings = await deps.fetchUserSettings(folder);
  } catch (err) {
    if (deps.isStale()) return;
    console.warn(`[harness] could not load settings for ${folder}; using ${DEFAULT_HARNESS}`, err);
    deps.setPiModel(undefined);
    deps.setHarness(DEFAULT_HARNESS);
    return;
  }
  if (deps.isStale()) return; // a newer folder load superseded this one
  deps.setPiModel(settings.piModel || undefined);
  if (!isHarnessChoice(settings.harness)) {
    deps.setHarness(DEFAULT_HARNESS);
    return;
  }
  if (harnessUnavailable(settings.harness, harnessAvail)) {
    deps.setHarness(DEFAULT_HARNESS);
    deps.patchUserSettings(folder, { harness: DEFAULT_HARNESS }).catch(() => {});
  } else {
    deps.setHarness(settings.harness);
  }
}
