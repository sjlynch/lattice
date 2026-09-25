import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUserSettingsStrict,
  type RestoreTerminalsMode,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
} from '../../api';
import {
  FETCHED_TOGGLE_DEFAULTS,
  FETCHED_TOGGLE_KEYS,
  noneTouched,
  pickSavableFetchedToggles,
  readFetchedToggles,
  type FetchedToggleKey,
  type FetchedToggles,
  type FetchedTogglesTouched,
} from './fetchedToggles';
import { type TerminalLaunchTouched } from './saveSettings';

function noLaunchFieldTouched(): TerminalLaunchTouched {
  return {
    terminalDefaultHarness: false,
    terminalClaudeSkipPermissions: false,
    codexYolo: false,
  };
}

// Draft state owned directly by SettingsDialog (the terminal-default section
// and the Claude-instrumentation toggle), plus the synchronization that
// reseeds it whenever the dialog (re)opens. The per-tab drafts live in each
// tab's own `use*`/ref handle; this hook keeps the parent's slice thin.
export type SettingsDrafts = {
  terminalDefaultHarness: TerminalDefaultHarness;
  setTerminalDefaultHarness: (value: TerminalDefaultHarness) => void;
  terminalClaudeSkipPermissions: boolean;
  setTerminalClaudeSkipPermissions: (value: boolean) => void;
  codexYolo: boolean;
  setCodexYolo: (value: boolean) => void;
  instrumentClaude: boolean;
  setInstrumentClaude: (value: boolean) => void;
  disableMemory: boolean;
  setDisableMemory: (value: boolean) => void;
  qaTerminalAutoClose: boolean;
  setQaTerminalAutoClose: (value: boolean) => void;
  keepWorkflowStepTerminals: boolean;
  setKeepWorkflowStepTerminals: (value: boolean) => void;
  // Terminal-tab restore (see api/types/terminalTabs.ts).
  restoreTerminalsOnOpen: RestoreTerminalsMode;
  setRestoreTerminalsOnOpen: (value: RestoreTerminalsMode) => void;
  restoreNudgeAgents: boolean;
  setRestoreNudgeAgents: (value: boolean) => void;
  restoreNudgeUserTabs: boolean;
  setRestoreNudgeUserTabs: (value: boolean) => void;
  // True when any parent-owned draft differs from its last-loaded value. Feeds
  // the Terminals tab's dirty dot and the warn-on-close check.
  dirty: boolean;
  // The fetched toggles that are safe to write on Save — see
  // `pickSavableFetchedToggles`.
  getSavableFetchedToggles: () => Partial<FetchedToggles>;
  // Which terminal-launch drafts the user edited since they were last seeded.
  // Until the project's settings load, the seed is App's defaults, not the
  // project's values — Save writes only these then (see saveSettings).
  getTerminalLaunchTouched: () => TerminalLaunchTouched;
};

export { pickSavableFetchedToggles } from './fetchedToggles';
export type { FetchedToggles } from './fetchedToggles';

export function useSettingsDrafts(
  open: boolean,
  activeFolder: string,
  terminalLaunchSettings: TerminalLaunchSettings,
): SettingsDrafts {
  const [terminalDefaultHarness, setTerminalDefaultHarnessState] =
    useState<TerminalDefaultHarness>(terminalLaunchSettings.terminalDefaultHarness);
  const [terminalClaudeSkipPermissions, setTerminalClaudeSkipPermissionsState] =
    useState(terminalLaunchSettings.terminalClaudeSkipPermissions);
  // Codex `--yolo` toggle — default ON (part of terminalLaunchSettings, so it's
  // reseeded from the same synchronous slice as the harness/skip drafts).
  const [codexYolo, setCodexYoloState] = useState(terminalLaunchSettings.codexYolo);
  // Reset on every reseed; set by a user edit of the matching draft.
  const terminalLaunchTouchedRef = useRef<TerminalLaunchTouched>(
    noLaunchFieldTouched(),
  );
  const setTerminalDefaultHarness = useCallback(
    (value: TerminalDefaultHarness) => {
      terminalLaunchTouchedRef.current.terminalDefaultHarness = true;
      setTerminalDefaultHarnessState(value);
    },
    [],
  );
  const setTerminalClaudeSkipPermissions = useCallback((value: boolean) => {
    terminalLaunchTouchedRef.current.terminalClaudeSkipPermissions = true;
    setTerminalClaudeSkipPermissionsState(value);
  }, []);
  const setCodexYolo = useCallback((value: boolean) => {
    terminalLaunchTouchedRef.current.codexYolo = true;
    setCodexYoloState(value);
  }, []);
  // The fetched toggles (see fetchedToggles.ts): current drafts, and the
  // last-loaded baselines so we can tell "dirty".
  const [fetched, setFetchedValues] =
    useState<FetchedToggles>(FETCHED_TOGGLE_DEFAULTS);
  const [loadedFetched, setLoadedFetched] =
    useState<FetchedToggles>(FETCHED_TOGGLE_DEFAULTS);
  // A settings GET can resolve after the user has already toggled one of these
  // fields. Track touched state outside render so the late response can update
  // dirty baselines without clobbering the user's draft value.
  const fetchedToggleTouchedRef = useRef<FetchedTogglesTouched>(noneTouched());
  // True once this open's settings GET succeeded (gates what Save may write).
  const [fetchedLoaded, setFetchedLoaded] = useState(false);

  // Reseed the terminal-default drafts from the latest saved settings each
  // time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTerminalDefaultHarnessState(terminalLaunchSettings.terminalDefaultHarness);
    setTerminalClaudeSkipPermissionsState(
      terminalLaunchSettings.terminalClaudeSkipPermissions,
    );
    setCodexYoloState(terminalLaunchSettings.codexYolo);
    terminalLaunchTouchedRef.current = noLaunchFieldTouched();
  }, [open, terminalLaunchSettings]);

  // User edit of one fetched toggle: mark it touched (so a late GET won't seed
  // over it) and set the draft. Same-value writes keep the previous object so
  // React still bails out of the re-render, as the per-field states did.
  const setFetched = useCallback(
    <K extends FetchedToggleKey>(key: K, value: FetchedToggles[K]) => {
      fetchedToggleTouchedRef.current[key] = true;
      setFetchedValues((prev) =>
        Object.is(prev[key], value) ? prev : { ...prev, [key]: value },
      );
    },
    [],
  );

  const setInstrumentClaudeDraft = useCallback(
    (value: boolean) => setFetched('instrumentClaude', value),
    [setFetched],
  );
  const setDisableMemoryDraft = useCallback(
    (value: boolean) => setFetched('disableMemory', value),
    [setFetched],
  );
  const setQaTerminalAutoCloseDraft = useCallback(
    (value: boolean) => setFetched('qaTerminalAutoClose', value),
    [setFetched],
  );
  const setKeepWorkflowStepTerminalsDraft = useCallback(
    (value: boolean) => setFetched('keepWorkflowStepTerminals', value),
    [setFetched],
  );
  const setRestoreTerminalsOnOpenDraft = useCallback(
    (value: RestoreTerminalsMode) => setFetched('restoreTerminalsOnOpen', value),
    [setFetched],
  );
  const setRestoreNudgeAgentsDraft = useCallback(
    (value: boolean) => setFetched('restoreNudgeAgents', value),
    [setFetched],
  );
  const setRestoreNudgeUserTabsDraft = useCallback(
    (value: boolean) => setFetched('restoreNudgeUserTabs', value),
    [setFetched],
  );

  // The instrument/memory/QA toggles aren't part of terminalLaunchSettings, so
  // fetch them fresh when the dialog opens. Seed only untouched drafts; always
  // refresh the loaded baselines so dirty reflects the saved value.
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    setFetchedLoaded(false);
    fetchedToggleTouchedRef.current = noneTouched();
    // Strict: a failed GET (a 502 mid backend restart) must throw rather than
    // read as `{}` — the lenient variant would seed every draft with its
    // default and mark it "loaded", so the next Save would write those
    // defaults over the project's real values.
    fetchUserSettingsStrict(activeFolder)
      .then((s) => {
        if (!cancelled) {
          const loaded = readFetchedToggles(s);
          // Which drafts to seed is decided now, from the touched flags as they
          // stand when the response lands.
          const touched = fetchedToggleTouchedRef.current;
          const seedKeys = FETCHED_TOGGLE_KEYS.filter((key) => !touched[key]);
          setLoadedFetched(loaded);
          setFetchedValues((prev) => {
            // Unchanged → same object, so React bails out as it did per field.
            if (seedKeys.every((key) => Object.is(prev[key], loaded[key]))) {
              return prev;
            }
            const next = { ...prev };
            for (const key of seedKeys) {
              (next as Record<string, unknown>)[key] = loaded[key];
            }
            return next;
          });
          setFetchedLoaded(true);
        }
      })
      .catch(() => { /* keep current draft; Save writes only touched fields */ });
    return () => { cancelled = true; };
  }, [open, activeFolder]);

  const dirty =
    terminalDefaultHarness !== terminalLaunchSettings.terminalDefaultHarness ||
    terminalClaudeSkipPermissions !==
      terminalLaunchSettings.terminalClaudeSkipPermissions ||
    codexYolo !== terminalLaunchSettings.codexYolo ||
    FETCHED_TOGGLE_KEYS.some((key) => fetched[key] !== loadedFetched[key]);

  const getSavableFetchedToggles = useCallback(
    () =>
      pickSavableFetchedToggles(
        fetched,
        fetchedToggleTouchedRef.current,
        fetchedLoaded,
      ),
    [fetched, fetchedLoaded],
  );

  const getTerminalLaunchTouched = useCallback(
    () => ({ ...terminalLaunchTouchedRef.current }),
    [],
  );

  return {
    terminalDefaultHarness,
    setTerminalDefaultHarness,
    terminalClaudeSkipPermissions,
    setTerminalClaudeSkipPermissions,
    codexYolo,
    setCodexYolo,
    instrumentClaude: fetched.instrumentClaude,
    setInstrumentClaude: setInstrumentClaudeDraft,
    disableMemory: fetched.disableMemory,
    setDisableMemory: setDisableMemoryDraft,
    qaTerminalAutoClose: fetched.qaTerminalAutoClose,
    setQaTerminalAutoClose: setQaTerminalAutoCloseDraft,
    keepWorkflowStepTerminals: fetched.keepWorkflowStepTerminals,
    setKeepWorkflowStepTerminals: setKeepWorkflowStepTerminalsDraft,
    restoreTerminalsOnOpen: fetched.restoreTerminalsOnOpen,
    setRestoreTerminalsOnOpen: setRestoreTerminalsOnOpenDraft,
    restoreNudgeAgents: fetched.restoreNudgeAgents,
    setRestoreNudgeAgents: setRestoreNudgeAgentsDraft,
    restoreNudgeUserTabs: fetched.restoreNudgeUserTabs,
    setRestoreNudgeUserTabs: setRestoreNudgeUserTabsDraft,
    dirty,
    getSavableFetchedToggles,
    getTerminalLaunchTouched,
  };
}
