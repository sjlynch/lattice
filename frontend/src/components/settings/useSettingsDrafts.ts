import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUserSettingsStrict,
  type RestoreTerminalsMode,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
} from '../../api';

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
};

// The drafts that are NOT part of the synchronous terminalLaunchSettings slice
// and so are seeded from a per-open GET /api/settings.
export type FetchedToggles = {
  instrumentClaude: boolean;
  disableMemory: boolean;
  qaTerminalAutoClose: boolean;
  restoreTerminalsOnOpen: RestoreTerminalsMode;
  restoreNudgeAgents: boolean;
  restoreNudgeUserTabs: boolean;
};

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

function normalizeRestoreMode(value: unknown): RestoreTerminalsMode {
  return value === 'ask' || value === 'never' ? value : 'always';
}

export function useSettingsDrafts(
  open: boolean,
  activeFolder: string,
  terminalLaunchSettings: TerminalLaunchSettings,
): SettingsDrafts {
  const [terminalDefaultHarness, setTerminalDefaultHarness] =
    useState<TerminalDefaultHarness>(terminalLaunchSettings.terminalDefaultHarness);
  const [terminalClaudeSkipPermissions, setTerminalClaudeSkipPermissions] =
    useState(terminalLaunchSettings.terminalClaudeSkipPermissions);
  // Codex `--yolo` toggle — default ON (part of terminalLaunchSettings, so it's
  // reseeded from the same synchronous slice as the harness/skip drafts).
  const [codexYolo, setCodexYolo] = useState(terminalLaunchSettings.codexYolo);
  // Default ON (opt-out) — absent setting counts as enabled.
  const [instrumentClaude, setInstrumentClaude] = useState(true);
  // Default ON (memory disabled) — absent setting counts as "off".
  const [disableMemory, setDisableMemory] = useState(true);
  // Default OFF (terminal stays open) — only an explicit `true` auto-closes.
  const [qaTerminalAutoClose, setQaTerminalAutoClose] = useState(false);
  // Terminal-tab restore: mode defaults to 'always', the agent nudge to ON,
  // the user-tab nudge to OFF (see backend userSettings/types.ts).
  const [restoreTerminalsOnOpen, setRestoreTerminalsOnOpen] =
    useState<RestoreTerminalsMode>('always');
  const [restoreNudgeAgents, setRestoreNudgeAgents] = useState(true);
  const [restoreNudgeUserTabs, setRestoreNudgeUserTabs] = useState(false);
  // Last-loaded baselines for the fetched toggles, so we can tell "dirty".
  const [loadedInstrumentClaude, setLoadedInstrumentClaude] = useState(true);
  const [loadedDisableMemory, setLoadedDisableMemory] = useState(true);
  const [loadedQaTerminalAutoClose, setLoadedQaTerminalAutoClose] =
    useState(false);
  const [loadedRestore, setLoadedRestore] = useState<{
    mode: RestoreTerminalsMode; agents: boolean; userTabs: boolean;
  }>({ mode: 'always', agents: true, userTabs: false });
  // A settings GET can resolve after the user has already toggled one of these
  // fields. Track touched state outside render so the late response can update
  // dirty baselines without clobbering the user's draft value.
  const fetchedToggleTouchedRef = useRef({
    instrumentClaude: false,
    disableMemory: false,
    qaTerminalAutoClose: false,
    restoreTerminalsOnOpen: false,
    restoreNudgeAgents: false,
    restoreNudgeUserTabs: false,
  });
  // True once this open's settings GET succeeded (gates what Save may write).
  const [fetchedLoaded, setFetchedLoaded] = useState(false);

  // Reseed the terminal-default drafts from the latest saved settings each
  // time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTerminalDefaultHarness(terminalLaunchSettings.terminalDefaultHarness);
    setTerminalClaudeSkipPermissions(
      terminalLaunchSettings.terminalClaudeSkipPermissions,
    );
    setCodexYolo(terminalLaunchSettings.codexYolo);
  }, [open, terminalLaunchSettings]);

  const setInstrumentClaudeDraft = useCallback((value: boolean) => {
    fetchedToggleTouchedRef.current.instrumentClaude = true;
    setInstrumentClaude(value);
  }, []);

  const setDisableMemoryDraft = useCallback((value: boolean) => {
    fetchedToggleTouchedRef.current.disableMemory = true;
    setDisableMemory(value);
  }, []);

  const setQaTerminalAutoCloseDraft = useCallback((value: boolean) => {
    fetchedToggleTouchedRef.current.qaTerminalAutoClose = true;
    setQaTerminalAutoClose(value);
  }, []);

  const setRestoreTerminalsOnOpenDraft = useCallback((value: RestoreTerminalsMode) => {
    fetchedToggleTouchedRef.current.restoreTerminalsOnOpen = true;
    setRestoreTerminalsOnOpen(value);
  }, []);
  const setRestoreNudgeAgentsDraft = useCallback((value: boolean) => {
    fetchedToggleTouchedRef.current.restoreNudgeAgents = true;
    setRestoreNudgeAgents(value);
  }, []);
  const setRestoreNudgeUserTabsDraft = useCallback((value: boolean) => {
    fetchedToggleTouchedRef.current.restoreNudgeUserTabs = true;
    setRestoreNudgeUserTabs(value);
  }, []);

  // The instrument/memory/QA toggles aren't part of terminalLaunchSettings, so
  // fetch them fresh when the dialog opens. Seed only untouched drafts; always
  // refresh the loaded baselines so dirty reflects the saved value.
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    setFetchedLoaded(false);
    fetchedToggleTouchedRef.current = {
      instrumentClaude: false,
      disableMemory: false,
      qaTerminalAutoClose: false,
      restoreTerminalsOnOpen: false,
      restoreNudgeAgents: false,
      restoreNudgeUserTabs: false,
    };
    // Strict: a failed GET (a 502 mid backend restart) must throw rather than
    // read as `{}` — the lenient variant would seed every draft with its
    // default and mark it "loaded", so the next Save would write those
    // defaults over the project's real values.
    fetchUserSettingsStrict(activeFolder)
      .then((s) => {
        if (!cancelled) {
          const instrument = s.instrumentProjectClaudeSessions !== false;
          const memory = s.disableClaudeMemory !== false;
          const qaAutoClose = s.qaTerminalAutoClose === true;
          const restoreMode = normalizeRestoreMode(s.restoreTerminalsOnOpen);
          const nudgeAgents = s.restoreNudgeAgents !== false;
          const nudgeUserTabs = s.restoreNudgeUserTabs === true;
          const touched = fetchedToggleTouchedRef.current;
          setLoadedInstrumentClaude(instrument);
          if (!touched.instrumentClaude) setInstrumentClaude(instrument);
          setLoadedDisableMemory(memory);
          if (!touched.disableMemory) setDisableMemory(memory);
          setLoadedQaTerminalAutoClose(qaAutoClose);
          if (!touched.qaTerminalAutoClose) setQaTerminalAutoClose(qaAutoClose);
          setLoadedRestore({ mode: restoreMode, agents: nudgeAgents, userTabs: nudgeUserTabs });
          if (!touched.restoreTerminalsOnOpen) setRestoreTerminalsOnOpen(restoreMode);
          if (!touched.restoreNudgeAgents) setRestoreNudgeAgents(nudgeAgents);
          if (!touched.restoreNudgeUserTabs) setRestoreNudgeUserTabs(nudgeUserTabs);
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
    instrumentClaude !== loadedInstrumentClaude ||
    disableMemory !== loadedDisableMemory ||
    qaTerminalAutoClose !== loadedQaTerminalAutoClose ||
    restoreTerminalsOnOpen !== loadedRestore.mode ||
    restoreNudgeAgents !== loadedRestore.agents ||
    restoreNudgeUserTabs !== loadedRestore.userTabs;

  const getSavableFetchedToggles = useCallback(
    () =>
      pickSavableFetchedToggles(
        {
          instrumentClaude,
          disableMemory,
          qaTerminalAutoClose,
          restoreTerminalsOnOpen,
          restoreNudgeAgents,
          restoreNudgeUserTabs,
        },
        fetchedToggleTouchedRef.current,
        fetchedLoaded,
      ),
    [
      instrumentClaude,
      disableMemory,
      qaTerminalAutoClose,
      restoreTerminalsOnOpen,
      restoreNudgeAgents,
      restoreNudgeUserTabs,
      fetchedLoaded,
    ],
  );

  return {
    terminalDefaultHarness,
    setTerminalDefaultHarness,
    terminalClaudeSkipPermissions,
    setTerminalClaudeSkipPermissions,
    codexYolo,
    setCodexYolo,
    instrumentClaude,
    setInstrumentClaude: setInstrumentClaudeDraft,
    disableMemory,
    setDisableMemory: setDisableMemoryDraft,
    qaTerminalAutoClose,
    setQaTerminalAutoClose: setQaTerminalAutoCloseDraft,
    restoreTerminalsOnOpen,
    setRestoreTerminalsOnOpen: setRestoreTerminalsOnOpenDraft,
    restoreNudgeAgents,
    setRestoreNudgeAgents: setRestoreNudgeAgentsDraft,
    restoreNudgeUserTabs,
    setRestoreNudgeUserTabs: setRestoreNudgeUserTabsDraft,
    dirty,
    getSavableFetchedToggles,
  };
}
