export type AgentHarness = 'claude' | 'pi' | 'codex';
export type HarnessChoice = AgentHarness | 'interleave';

export type HarnessAvailability = Record<AgentHarness, boolean>;

export const ALL_AGENT_HARNESSES: readonly AgentHarness[] = [
  'claude',
  'pi',
  'codex',
] as const;

export const ALL_HARNESS_CHOICES: readonly HarnessChoice[] = [
  ...ALL_AGENT_HARNESSES,
  'interleave',
] as const;

export const HARNESS_LABELS: Record<HarnessChoice | 'default', string> = {
  default: 'Default',
  claude: 'Claude',
  pi: 'Pi',
  codex: 'Codex',
  interleave: 'Interleave',
};

export function isAgentHarness(value: unknown): value is AgentHarness {
  return value === 'claude' || value === 'pi' || value === 'codex';
}

export function normalizeAgentHarness(value: unknown): AgentHarness {
  return isAgentHarness(value) ? value : 'claude';
}

export function isHarnessChoice(value: unknown): value is HarnessChoice {
  return isAgentHarness(value) || value === 'interleave';
}

export function harnessLabel(value: HarnessChoice | 'default' | null | undefined): string {
  return HARNESS_LABELS[value ?? 'default'];
}

export function availableAgentHarnesses(
  harnessAvail: HarnessAvailability,
  selected?: AgentHarness | null,
): AgentHarness[] {
  const options: AgentHarness[] = ['claude'];
  if (harnessAvail.pi || selected === 'pi') options.push('pi');
  if (harnessAvail.codex || selected === 'codex') options.push('codex');
  return options;
}

export function availableHarnessChoices(
  harnessAvail: HarnessAvailability,
  selected?: HarnessChoice | null,
): HarnessChoice[] {
  const options: HarnessChoice[] = availableAgentHarnesses(
    harnessAvail,
    isAgentHarness(selected) ? selected : null,
  );
  if (harnessAvail.pi || selected === 'interleave') options.push('interleave');
  return options;
}

// ---------------------------------------------------------------------------
// Pi model selection
//
// A harness dropdown surfaces one row per curated Pi model ("Pi — X") in
// addition to the bare harness rows. The data model stays two parallel fields
// (`harness` + `piModel`); the dropdown encodes both into a single `<select>`
// value so the existing single-select UI keeps working:
//   "claude" | "codex" | "pi" | "pi:<provider/model>" | "interleave"
// ---------------------------------------------------------------------------

// One curated Pi model offered in the dropdowns. `label` is the friendly name
// WITHOUT the "Pi — " prefix (the option builder adds it). From GET
// /api/pi-models `.menu`.
export type PiModelMenuEntry = { pattern: string; label: string };

export type HarnessSelection = { harness: HarnessChoice; piModel?: string };

const PI_MODEL_VALUE_PREFIX = 'pi:';

// Mirrors the backend's PI_MODEL_PATTERN_RE (worktree/commands.ts): a
// `provider/model[:thinking]` token of safe chars only. Used as a
// shell-injection guard before a Pi model ever lands in a command string.
const PI_MODEL_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/;

export function isValidPiModel(piModel: string | undefined): piModel is string {
  return !!piModel && PI_MODEL_RE.test(piModel);
}

export function encodeHarnessValue(harness: HarnessChoice, piModel?: string): string {
  return harness === 'pi' && piModel ? `${PI_MODEL_VALUE_PREFIX}${piModel}` : harness;
}

export function decodeHarnessValue(value: string): HarnessSelection {
  if (value.startsWith(PI_MODEL_VALUE_PREFIX)) {
    const piModel = value.slice(PI_MODEL_VALUE_PREFIX.length);
    return piModel ? { harness: 'pi', piModel } : { harness: 'pi' };
  }
  return { harness: isHarnessChoice(value) ? value : 'claude' };
}

// `title` carries the full, un-truncated tooltip text for an option (and, when
// selected, for the closed control). For "Pi — X" rows it is the full
// `provider/model` id, so the value is never hidden even when the visible
// `label` is shortened or the closed `<select>` ellipsis-clips it.
export type HarnessOption = { value: string; label: string; title?: string };

// Curated Pi model ids are arbitrary `provider/model` strings (vLLM / custom
// endpoints) that can be long. Cap the VISIBLE label so it doesn't blow out the
// closed control; the full id always rides along in `title` (a hover tooltip).
const PI_LABEL_MAX_CHARS = 28;

function piModelDisplayLabel(entry: PiModelMenuEntry): string {
  // Prefer a real friendly name from the menu; otherwise fall back to the model
  // segment of `provider/model` (dropping the provider prefix and any
  // `:thinking` suffix), matching workflowRunOverrideLabel's shortening.
  const friendly =
    entry.label && entry.label !== entry.pattern
      ? entry.label
      : entry.pattern.split('/').pop()?.split(':')[0] || entry.pattern;
  return friendly.length > PI_LABEL_MAX_CHARS
    ? `${friendly.slice(0, PI_LABEL_MAX_CHARS - 1)}…`
    : friendly;
}

// Build the flattened dropdown option list for a harness selector. `piMenu`
// expands into "Pi — X" rows beneath bare "Pi"; an already-selected Pi model
// not present in the menu is appended so a saved choice never silently
// disappears. `includeInterleave` adds the round-robin option (taskboard only).
export function buildHarnessOptions(args: {
  harnessAvail: HarnessAvailability;
  piMenu: PiModelMenuEntry[];
  selected: HarnessSelection;
  includeInterleave: boolean;
}): HarnessOption[] {
  const { harnessAvail, piMenu, selected, includeInterleave } = args;
  const piVisible = harnessAvail.pi || selected.harness === 'pi';
  const options: HarnessOption[] = [{ value: 'claude', label: HARNESS_LABELS.claude }];
  if (harnessAvail.codex || selected.harness === 'codex') {
    options.push({ value: 'codex', label: HARNESS_LABELS.codex });
  }
  if (piVisible) {
    options.push({ value: 'pi', label: HARNESS_LABELS.pi });
    const entries = [...piMenu];
    // Keep a saved-but-uncurated Pi model selectable.
    if (
      selected.harness === 'pi' &&
      selected.piModel &&
      !entries.some((e) => e.pattern === selected.piModel)
    ) {
      entries.push({ pattern: selected.piModel, label: selected.piModel });
    }
    for (const entry of entries) {
      options.push({
        value: encodeHarnessValue('pi', entry.pattern),
        label: `${HARNESS_LABELS.pi} — ${piModelDisplayLabel(entry)}`,
        // Full `provider/model` for the tooltip — never truncated.
        title: `${HARNESS_LABELS.pi} — ${entry.pattern}`,
      });
    }
  }
  if (includeInterleave && (harnessAvail.pi || selected.harness === 'interleave')) {
    options.push({ value: 'interleave', label: HARNESS_LABELS.interleave });
  }
  return options;
}

// The full-value tooltip for whichever option a <select> currently has selected
// — its `title` (full `provider/model` for a Pi row) or, failing that, its
// visible `label`. Lets a truncated closed control reveal exactly what runs.
export function selectedOptionTitle(options: HarnessOption[], value: string): string {
  const selected = options.find((o) => o.value === value);
  return selected?.title ?? selected?.label ?? '';
}
