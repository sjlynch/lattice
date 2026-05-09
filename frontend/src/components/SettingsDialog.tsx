import { useEffect, useState } from 'react';
import { Plus, Trash2, TerminalSquare } from 'lucide-react';
import { Modal } from './Modal';
import { patchUserSettings, type StartupTerminal } from '../api';

type Props = {
  open: boolean;
  onClose: () => void;
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
};

type Tab = 'terminals';

function makeId(): string {
  return `st_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function SettingsDialog({
  open,
  onClose,
  activeFolder,
  startupTerminals,
  onStartupTerminalsChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('terminals');
  const [draft, setDraft] = useState<StartupTerminal[]>(startupTerminals);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the local edit buffer whenever the dialog opens or the upstream
  // list changes (e.g. user just hit Restart and the list was re-saved).
  useEffect(() => {
    if (open) {
      setDraft(startupTerminals);
      setError(null);
    }
  }, [open, startupTerminals]);

  const addRow = () => {
    setDraft((d) => [
      ...d,
      { id: makeId(), label: `startup ${d.length + 1}`, command: '' },
    ]);
  };

  const removeRow = (id: string) => {
    setDraft((d) => d.filter((t) => t.id !== id));
  };

  const updateRow = (id: string, patch: Partial<StartupTerminal>) => {
    setDraft((d) => d.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const save = async () => {
    if (!activeFolder) return;
    setSaving(true);
    setError(null);
    try {
      const cleaned = draft
        .map((t) => ({
          id: t.id,
          label: t.label.trim() || 'startup',
          command: t.command.trim(),
        }))
        .filter((t) => t.command.length > 0);
      await patchUserSettings(activeFolder, { startupTerminals: cleaned });
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
        </div>
        <div className="settings-tab-body">
          {tab === 'terminals' && (
            <div className="settings-section">
              <div className="settings-section-header">
                <div>
                  <div className="settings-section-title">Startup Terminals</div>
                  <div className="settings-section-sub">
                    Commands here run automatically in new terminals each time
                    the page loads. They show up under the “Startup” tab in the
                    sidebar.
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  onClick={addRow}
                  title="Add a startup terminal"
                >
                  <Plus size={12} />
                  Add
                </button>
              </div>
              {draft.length === 0 ? (
                <div className="settings-empty">No startup terminals.</div>
              ) : (
                <div className="startup-list">
                  {draft.map((t) => (
                    <div key={t.id} className="startup-row">
                      <input
                        className="text-input startup-label"
                        placeholder="label"
                        value={t.label}
                        onChange={(e) => updateRow(t.id, { label: e.target.value })}
                        spellCheck={false}
                      />
                      <input
                        className="text-input startup-command"
                        placeholder="command (e.g. npm run dev)"
                        value={t.command}
                        onChange={(e) =>
                          updateRow(t.id, { command: e.target.value })
                        }
                        spellCheck={false}
                      />
                      <button
                        className="icon-btn sm"
                        onClick={() => removeRow(t.id)}
                        title="Remove"
                        aria-label="Remove startup terminal"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
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
