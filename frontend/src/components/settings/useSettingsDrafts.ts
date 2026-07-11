import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUserSettings,
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
  // True when any parent-owned draft differs from its last-loaded value. Feeds
  // the Terminals tab's dirty dot and the warn-on-close check.
  dirty: boolean;
};

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
  // Last-loaded baselines for the fetched toggles, so we can tell "dirty".
  const [loadedInstrumentClaude, setLoadedInstrumentClaude] = useState(true);
  const [loadedDisableMemory, setLoadedDisableMemory] = useState(true);
  const [loadedQaTerminalAutoClose, setLoadedQaTerminalAutoClose] =
    useState(false);
  // A settings GET can resolve after the user has already toggled one of these
  // fields. Track touched state outside render so the late response can update
  // dirty baselines without clobbering the user's draft value.
  const fetchedToggleTouchedRef = useRef({
    instrumentClaude: false,
    disableMemory: false,
    qaTerminalAutoClose: false,
  });

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

  // The instrument/memory/QA toggles aren't part of terminalLaunchSettings, so
  // fetch them fresh when the dialog opens. Seed only untouched drafts; always
  // refresh the loaded baselines so dirty reflects the saved value.
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    fetchedToggleTouchedRef.current = {
      instrumentClaude: false,
      disableMemory: false,
      qaTerminalAutoClose: false,
    };
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (!cancelled) {
          const instrument = s.instrumentProjectClaudeSessions !== false;
          const memory = s.disableClaudeMemory !== false;
          const qaAutoClose = s.qaTerminalAutoClose === true;
          const touched = fetchedToggleTouchedRef.current;
          setLoadedInstrumentClaude(instrument);
          if (!touched.instrumentClaude) setInstrumentClaude(instrument);
          setLoadedDisableMemory(memory);
          if (!touched.disableMemory) setDisableMemory(memory);
          setLoadedQaTerminalAutoClose(qaAutoClose);
          if (!touched.qaTerminalAutoClose) setQaTerminalAutoClose(qaAutoClose);
        }
      })
      .catch(() => { /* keep current draft */ });
    return () => { cancelled = true; };
  }, [open, activeFolder]);

  const dirty =
    terminalDefaultHarness !== terminalLaunchSettings.terminalDefaultHarness ||
    terminalClaudeSkipPermissions !==
      terminalLaunchSettings.terminalClaudeSkipPermissions ||
    codexYolo !== terminalLaunchSettings.codexYolo ||
    instrumentClaude !== loadedInstrumentClaude ||
    disableMemory !== loadedDisableMemory ||
    qaTerminalAutoClose !== loadedQaTerminalAutoClose;

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
    dirty,
  };
}
