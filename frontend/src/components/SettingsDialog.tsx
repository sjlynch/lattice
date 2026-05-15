import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, FileText, BarChart3 } from 'lucide-react';
import { Modal } from './Modal';
import {
  patchUserSettings,
  type StartupTerminal,
  type UserSettings,
} from '../api';
import {
  cleanStartupTerminals,
  StartupTerminalsTab,
  type StartupTerminalsTabHandle,
} from './settings/StartupTerminalsTab';
import {
  EnvNotesTab,
  type EnvNotesTabHandle,
} from './settings/EnvNotesTab';
import {
  MetricsIgnoredExtsTab,
  type MetricsIgnoredExtsTabHandle,
} from './settings/MetricsIgnoredExtsTab';

type Props = {
  open: boolean;
  onClose: () => void;
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  metricsIgnoredExts: string[];
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
};

type Tab = 'terminals' | 'env' | 'metrics';

export function SettingsDialog({
  open,
  onClose,
  activeFolder,
  startupTerminals,
  onStartupTerminalsChange,
  metricsIgnoredExts,
  onMetricsIgnoredExtsChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('terminals');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startupTerminalsRef = useRef<StartupTerminalsTabHandle>(null);
  const envNotesRef = useRef<EnvNotesTabHandle>(null);
  const metricsIgnoredExtsRef = useRef<MetricsIgnoredExtsTabHandle>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open, startupTerminals]);

  const save = async () => {
    if (!activeFolder) return;
    setSaving(true);
    setError(null);
    try {
      const cleaned =
        startupTerminalsRef.current?.getCleanedTerminals() ??
        cleanStartupTerminals(startupTerminals);
      const patch: Partial<UserSettings> = { startupTerminals: cleaned };
      // Only touch worktreeEnvNotes if the env fetch finished — otherwise we'd
      // overwrite the saved overrides with an empty map.
      const envNotesPatch = envNotesRef.current?.getWorktreeEnvNotesPatch();
      if (envNotesPatch !== undefined) patch.worktreeEnvNotes = envNotesPatch;
      const metricsExtsPatch =
        metricsIgnoredExtsRef.current?.getMetricsIgnoredExtsPatch();
      if (metricsExtsPatch !== undefined) {
        patch.metricsIgnoredExts = metricsExtsPatch;
      }
      await patchUserSettings(activeFolder, patch);
      onStartupTerminalsChange(cleaned);
      if (metricsExtsPatch !== undefined) {
        await onMetricsIgnoredExtsChange(metricsExtsPatch);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={620}>
      <div className="modal-header">Settings</div>
      <div className="settings-body">
        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === 'terminals' ? 'active' : ''}`}
            onClick={() => setTab('terminals')}
          >
            <TerminalSquare size={12} />
            Terminals
          </button>
          <button
            className={`settings-tab ${tab === 'env' ? 'active' : ''}`}
            onClick={() => setTab('env')}
          >
            <FileText size={12} />
            Agent instructions
          </button>
          <button
            className={`settings-tab ${tab === 'metrics' ? 'active' : ''}`}
            onClick={() => setTab('metrics')}
          >
            <BarChart3 size={12} />
            Metrics
          </button>
        </div>
        <div className="settings-tab-body">
          <StartupTerminalsTab
            ref={startupTerminalsRef}
            active={tab === 'terminals'}
            open={open}
            startupTerminals={startupTerminals}
          />
          <EnvNotesTab
            ref={envNotesRef}
            active={tab === 'env'}
            open={open}
            activeFolder={activeFolder}
          />
          <MetricsIgnoredExtsTab
            ref={metricsIgnoredExtsRef}
            active={tab === 'metrics'}
            open={open}
            metricsIgnoredExts={metricsIgnoredExts}
          />
        </div>
      </div>
      {error && <div className="error-msg" style={{ margin: '0 16px' }}>{error}</div>}
      <div className="modal-footer">
        <button className="btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={save}
          disabled={saving || !activeFolder}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
