import { useEffect, useState } from 'react';
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

  // Reseed the terminal-default drafts from the latest saved settings each
  // time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTerminalDefaultHarness(terminalLaunchSettings.terminalDefaultHarness);
    setTerminalClaudeSkipPermissions(
      terminalLaunchSettings.terminalClaudeSkipPermissions,
    );
  }, [open, terminalLaunchSettings]);

  // The instrument toggle isn't part of terminalLaunchSettings, so fetch it
  // fresh when the dialog opens.
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (!cancelled) {
          const instrument = s.instrumentProjectClaudeSessions !== false;
          const memory = s.disableClaudeMemory !== false;
          const qaAutoClose = s.qaTerminalAutoClose === true;
          setInstrumentClaude(instrument);
          setLoadedInstrumentClaude(instrument);
          setDisableMemory(memory);
          setLoadedDisableMemory(memory);
          setQaTerminalAutoClose(qaAutoClose);
          setLoadedQaTerminalAutoClose(qaAutoClose);
        }
      })
      .catch(() => { /* keep current draft */ });
    return () => { cancelled = true; };
  }, [open, activeFolder]);

  const dirty =
    terminalDefaultHarness !== terminalLaunchSettings.terminalDefaultHarness ||
    terminalClaudeSkipPermissions !==
      terminalLaunchSettings.terminalClaudeSkipPermissions ||
    instrumentClaude !== loadedInstrumentClaude ||
    disableMemory !== loadedDisableMemory ||
    qaTerminalAutoClose !== loadedQaTerminalAutoClose;

  return {
    terminalDefaultHarness,
    setTerminalDefaultHarness,
    terminalClaudeSkipPermissions,
    setTerminalClaudeSkipPermissions,
    instrumentClaude,
    setInstrumentClaude,
    disableMemory,
    setDisableMemory,
    qaTerminalAutoClose,
    setQaTerminalAutoClose,
    dirty,
  };
}
