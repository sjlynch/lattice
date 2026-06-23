import type { HarnessAvailability, WorkflowRunHarnessOverride } from '../../api';
import {
  buildHarnessOptions,
  decodeHarnessValue,
  encodeHarnessValue,
  HARNESS_LABELS,
  isAgentHarness,
  type HarnessOption,
  type PiModelMenuEntry,
} from '../../harnesses';

export const DEFAULT_WORKFLOW_HARNESS_VALUE = 'default';

// A workflow run override = an agent harness (never `interleave`) plus, when
// that harness is `pi`, a specific model. `harness: null` means "Default" (each
// step keeps its own stored harness/model).
export type WorkflowRunOverrideSelection = {
  harness: WorkflowRunHarnessOverride;
  piModel?: string;
};

// <select> value ⇄ override. Reuses the shared `pi:<provider/model>` encoding so
// the run-override dropdown matches the taskboard/step pickers exactly.
export function serializeWorkflowRunOverride(
  harness: WorkflowRunHarnessOverride,
  piModel?: string,
): string {
  return harness === null
    ? DEFAULT_WORKFLOW_HARNESS_VALUE
    : encodeHarnessValue(harness, piModel);
}

export function parseWorkflowRunOverride(
  value: string,
): WorkflowRunOverrideSelection {
  if (value === DEFAULT_WORKFLOW_HARNESS_VALUE) return { harness: null };
  const sel = decodeHarnessValue(value);
  // `interleave` isn't offered as a run override, so coerce anything that isn't
  // a concrete agent harness back to Default.
  return {
    harness: isAgentHarness(sel.harness) ? sel.harness : null,
    piModel: sel.piModel,
  };
}

// The shared option list for a run-override <select>: "Default" plus the
// flattened harness + "Pi — X" rows (no interleave). One stable array per
// availability/menu change keeps the memoized saved-list rows from re-rendering.
export function workflowRunOverrideOptions(
  harnessAvail: HarnessAvailability,
  piMenu: PiModelMenuEntry[],
): HarnessOption[] {
  return [
    { value: DEFAULT_WORKFLOW_HARNESS_VALUE, label: 'Default' },
    ...buildHarnessOptions({
      harnessAvail,
      piMenu,
      selected: { harness: 'claude' },
      includeInterleave: false,
    }),
  ];
}

// Short label for a captured override (run / queued-entry display): "Default",
// "Claude", "Pi — <model>", etc.
export function workflowRunOverrideLabel(
  harness: WorkflowRunHarnessOverride | undefined,
  piModel?: string,
): string {
  if (!harness) return HARNESS_LABELS.default;
  if (harness === 'pi' && piModel) {
    const short = piModel.split('/').pop()?.split(':')[0] ?? piModel;
    return `${HARNESS_LABELS.pi} — ${short}`;
  }
  return HARNESS_LABELS[harness];
}
