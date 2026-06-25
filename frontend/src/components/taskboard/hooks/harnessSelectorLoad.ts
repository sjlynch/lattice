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
  // True once a newer load has superseded this one. Evaluated AFTER the fetch
  // resolves: on a fast project switch a slow project-A response must not
  // overwrite the just-selected project B's harness/Pi state, nor persist a
  // coerced `harness: claude` patch under the wrong (now-inactive) folder.
  isStale: () => boolean;
  setHarness: (harness: HarnessChoice) => void;
  setPiModel: (piModel: string | undefined) => void;
};

// Load the persisted harness + Pi model for `folder` and apply it through the
// provided setters — unless a newer load won the race, in which case the whole
// stale response is dropped. Mirrors the prior inline effect body exactly aside
// from the `isStale()` guard.
export async function loadHarnessForFolder(
  folder: string,
  harnessAvail: HarnessAvailability,
  deps: HarnessSettingsLoadDeps,
): Promise<void> {
  let settings: UserSettings;
  try {
    settings = await deps.fetchUserSettings(folder);
  } catch {
    return; // keep current defaults
  }
  if (deps.isStale()) return; // a newer folder load superseded this one
  deps.setPiModel(settings.piModel || undefined);
  if (!isHarnessChoice(settings.harness)) return;
  if (harnessUnavailable(settings.harness, harnessAvail)) {
    deps.setHarness('claude');
    deps.patchUserSettings(folder, { harness: 'claude' }).catch(() => {});
  } else {
    deps.setHarness(settings.harness);
  }
}
