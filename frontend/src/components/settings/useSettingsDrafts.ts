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
          setInstrumentClaude(s.instrumentProjectClaudeSessions !== false);
          setDisableMemory(s.disableClaudeMemory !== false);
          setQaTerminalAutoClose(s.qaTerminalAutoClose === true);
        }
      })
      .catch(() => { /* keep current draft */ });
    return () => { cancelled = true; };
  }, [open, activeFolder]);

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
  };
}
