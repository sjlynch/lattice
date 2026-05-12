import { useEffect, useState } from 'react';
import { Plus, Trash2, TerminalSquare, FileText, RotateCcw } from 'lucide-react';
import { Modal } from './Modal';
import {
  fetchProjectEnv,
  fetchUserSettings,
  patchUserSettings,
  type ProjectEnvInfo,
  type StartupTerminal,
  type UserSettings,
} from '../api';

type Props = {
  open: boolean;
  onClose: () => void;
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
};

type Tab = 'terminals' | 'env';

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

  // Worktree env-note state. `envs` is what the backend detected (+ default
  // and effective notes); `envDraft` is the editable text keyed by env id;
  // `existingOverrides` is the raw saved map so we don't clobber overrides
  // for envs that aren't currently detected.
  const [envs, setEnvs] = useState<ProjectEnvInfo[]>([]);
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [existingOverrides, setExistingOverrides] = useState<Record<string, string>>({});
  const [envLoading, setEnvLoading] = useState(false);
  // Guards against saving (and clobbering) `worktreeEnvNotes` before the
  // fetch that seeds `existingOverrides` / `envDraft` has completed.
  const [envLoaded, setEnvLoaded] = useState(false);

  // Reset the local edit buffers whenever the dialog opens or the upstream
  // list changes (e.g. user just hit Restart and the list was re-saved).
  useEffect(() => {
    if (open) {
      setDraft(startupTerminals);
      setError(null);
    }
  }, [open, startupTerminals]);

  // Fetch detected environments + current overrides each time the dialog
  // opens (cheap, and keeps it fresh if the user just `npm install`ed).
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    setEnvLoading(true);
    setEnvLoaded(false);
    Promise.all([fetchProjectEnv(activeFolder), fetchUserSettings(activeFolder)])
      .then(([envResp, settings]) => {
        if (cancelled) return;
        const overrides = settings.worktreeEnvNotes ?? {};
        setEnvs(envResp.environments);
        setExistingOverrides(overrides);
        setEnvDraft(
          Object.fromEntries(envResp.environments.map((e) => [e.id, e.effectiveNote])),
        );
        setEnvLoaded(true);
      })
      .finally(() => {
        if (!cancelled) setEnvLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeFolder]);

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

  // Build the `worktreeEnvNotes` map to persist: start from whatever's
  // already saved (so overrides for undetected envs survive), then for each
  // detected env drop the key when the text equals the built-in default,
  // otherwise store the edited text (an empty string deliberately suppresses
  // the note for that env).
  const buildEnvNotesPatch = (): Record<string, string> => {
    const next: Record<string, string> = { ...existingOverrides };
    for (const env of envs) {
      const text = envDraft[env.id] ?? env.effectiveNote;
      if (text.trim() === env.defaultNote.trim()) {
        delete next[env.id];
      } else {
        next[env.id] = text;
      }
    }
    return next;
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
      const patch: Partial<UserSettings> = { startupTerminals: cleaned };
      // Only touch worktreeEnvNotes if the env fetch finished — otherwise we'd
      // overwrite the saved overrides with an empty map.
      if (envLoaded) patch.worktreeEnvNotes = buildEnvNotesPatch();
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
          {tab === 'env' && (
            <div className="settings-section">
              <div className="settings-section-header">
                <div>
                  <div className="settings-section-title">Worktree environment notes</div>
                  <div className="settings-section-sub">
                    Each task runs in a throwaway git worktree where gitignored
                    dependency dirs (<code>node_modules</code>, <code>.venv</code>,
                    <code> target</code>, …) aren’t checked out. When Lattice
                    detects a package manager it prepends a short note to that
                    task’s <code>LATTICE_TASK.md</code> (and
                    <code> MERGE_INSTRUCTIONS.md</code>) telling the agent not to
                    reinstall unless the task actually needs it — saving the
                    agent from deliberating and running <code>install</code>.
                    Edit the note below, or clear the box to remove it entirely.
                  </div>
                </div>
              </div>
              {envLoading ? (
                <div className="settings-empty">Loading…</div>
              ) : envs.length === 0 ? (
                <div className="settings-empty">
                  No package-manager environments detected at this project’s
                  root — Lattice doesn’t add anything to task instructions here.
                </div>
              ) : (
                <div className="env-note-list">
                  {envs.map((env) => {
                    const text = envDraft[env.id] ?? env.effectiveNote;
                    const isDefault = text.trim() === env.defaultNote.trim();
                    const disabled = text.trim().length === 0;
                    return (
                      <div key={env.id} className="env-note-card">
                        <div className="env-note-card-header">
                          <div className="env-note-card-title">
                            {env.label}
                            <span className="env-note-card-manager">{env.manager}</span>
                            <span className="env-note-card-dir">{env.heavyDir}/</span>
                          </div>
                          <button
                            className="btn-ghost"
                            disabled={isDefault}
                            onClick={() =>
                              setEnvDraft((d) => ({ ...d, [env.id]: env.defaultNote }))
                            }
                            title="Reset to Lattice's default note"
                          >
                            <RotateCcw size={12} />
                            Reset
                          </button>
                        </div>
                        <textarea
                          className="text-input env-note-textarea"
                          value={text}
                          spellCheck={false}
                          rows={5}
                          placeholder="(empty — no note will be added for this environment)"
                          onChange={(e) =>
                            setEnvDraft((d) => ({ ...d, [env.id]: e.target.value }))
                          }
                        />
                        <div className="env-note-card-hint">
                          {disabled
                            ? 'Disabled — nothing will be injected for this environment.'
                            : isDefault
                              ? 'Using Lattice’s default note.'
                              : 'Customized.'}
                        </div>
                      </div>
                    );
                  })}
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
