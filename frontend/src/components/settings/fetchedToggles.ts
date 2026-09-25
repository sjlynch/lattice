import type { RestoreTerminalsMode, UserSettings } from '../../api';

// The drafts that are NOT part of the synchronous terminalLaunchSettings slice
// and so are seeded from a per-open GET /api/settings. Adding one means: a key
// here, its default in FETCHED_TOGGLE_DEFAULTS, its read in readFetchedToggles,
// and its flat value/setter pair on `SettingsDrafts`.
export type FetchedToggles = {
  instrumentClaude: boolean;
  disableMemory: boolean;
  qaTerminalAutoClose: boolean;
  keepWorkflowStepTerminals: boolean;
  restoreTerminalsOnOpen: RestoreTerminalsMode;
  restoreNudgeAgents: boolean;
  restoreNudgeUserTabs: boolean;
};

export type FetchedToggleKey = keyof FetchedToggles;
export type FetchedTogglesTouched = Record<FetchedToggleKey, boolean>;

// The value each draft (and its dirty baseline) holds before this open's GET
// resolves — i.e. what an absent setting means. Key order is the save-payload
// order.
export const FETCHED_TOGGLE_DEFAULTS: Readonly<FetchedToggles> = {
  // Default ON (opt-out) — absent setting counts as enabled.
  instrumentClaude: true,
  // Default ON (memory disabled) — absent setting counts as "off".
  disableMemory: true,
  // Default OFF (terminal stays open) — only an explicit `true` auto-closes.
  qaTerminalAutoClose: false,
  // Default OFF (a finished workflow step's tab closes) — only `true` keeps it.
  keepWorkflowStepTerminals: false,
  // Terminal-tab restore: mode defaults to 'always', the agent nudge to ON,
  // the user-tab nudge to OFF (see backend userSettings/types.ts).
  restoreTerminalsOnOpen: 'always',
  restoreNudgeAgents: true,
  restoreNudgeUserTabs: false,
};

export const FETCHED_TOGGLE_KEYS = Object.keys(
  FETCHED_TOGGLE_DEFAULTS,
) as FetchedToggleKey[];

export function normalizeRestoreMode(value: unknown): RestoreTerminalsMode {
  return value === 'ask' || value === 'never' ? value : 'always';
}

// The saved settings → the draft values, applying each field's absent-means
// default (the same defaults as FETCHED_TOGGLE_DEFAULTS).
export function readFetchedToggles(s: UserSettings): FetchedToggles {
  return {
    instrumentClaude: s.instrumentProjectClaudeSessions !== false,
    disableMemory: s.disableClaudeMemory !== false,
    qaTerminalAutoClose: s.qaTerminalAutoClose === true,
    keepWorkflowStepTerminals: s.keepWorkflowStepTerminals === true,
    restoreTerminalsOnOpen: normalizeRestoreMode(s.restoreTerminalsOnOpen),
    restoreNudgeAgents: s.restoreNudgeAgents !== false,
    restoreNudgeUserTabs: s.restoreNudgeUserTabs === true,
  };
}

// A fresh all-false touched map (one per dialog open).
export function noneTouched(): FetchedTogglesTouched {
  const out = {} as FetchedTogglesTouched;
  for (const key of FETCHED_TOGGLE_KEYS) out[key] = false;
  return out;
}

// Which fetched toggles a Save may write. Until the settings GET has
// succeeded, an untouched draft still holds the hard-coded default (or the
// previous open's value), NOT the project's saved value — writing it would
// silently reset e.g. a saved `qaTerminalAutoClose: true` or
// `restoreTerminalsOnOpen: 'never'` whenever the user saved another tab while
// the fetch was slow or had failed (a backend restart). So: everything once
// loaded, otherwise only the fields the user actually edited.
export function pickSavableFetchedToggles(
  values: FetchedToggles,
  touched: Record<keyof FetchedToggles, boolean>,
  loaded: boolean,
): Partial<FetchedToggles> {
  if (loaded) return { ...values };
  const out: Partial<FetchedToggles> = {};
  for (const key of Object.keys(values) as (keyof FetchedToggles)[]) {
    if (touched[key]) (out as Record<string, unknown>)[key] = values[key];
  }
  return out;
}
