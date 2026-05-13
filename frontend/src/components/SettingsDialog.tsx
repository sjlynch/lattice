import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, FileText } from 'lucide-react';
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

type Props = {
  open: boolean;
  onClose: () => void;
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
};

type Tab = 'terminals' | 'env';

export function SettingsDialog({
  open,
  onClose,
  activeFolder,
  startupTerminals,
  onStartupTerminalsChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('terminals');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startupTerminalsRef = useRef<StartupTerminalsTabHandle>(null);
  const envNotesRef = useRef<EnvNotesTabHandle>(null);

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
      await patchUserSettings(activeFolder, patch);
      onStartupTerminalsChange(cleaned);
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
