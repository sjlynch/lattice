import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { StartupTerminal } from '../../api';

type Props = {
  active: boolean;
  open: boolean;
  startupTerminals: StartupTerminal[];
};

export type StartupTerminalsTabHandle = {
  getCleanedTerminals: () => StartupTerminal[];
};

function makeId(): string {
  return `st_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function cleanStartupTerminals(terminals: StartupTerminal[]): StartupTerminal[] {
  return terminals
    .map((t) => ({
      id: t.id,
      label: t.label.trim() || 'startup',
      command: t.command.trim(),
    }))
    .filter((t) => t.command.length > 0);
}

export const StartupTerminalsTab = forwardRef<StartupTerminalsTabHandle, Props>(
  function StartupTerminalsTab({ active, open, startupTerminals }, ref) {
    const [draft, setDraft] = useState<StartupTerminal[]>(startupTerminals);

    // Reset the local edit buffer whenever the dialog opens or the upstream
    // list changes (e.g. user just hit Restart and the list was re-saved).
    useEffect(() => {
      if (open) setDraft(startupTerminals);
    }, [open, startupTerminals]);

    useImperativeHandle(
      ref,
      () => ({
        getCleanedTerminals: () => cleanStartupTerminals(draft),
      }),
      [draft],
    );

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

    if (!active) return null;

    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Startup Terminals</div>
            <div className="settings-section-sub">
              Commands here run automatically in new terminals each time the page
              loads. They show up under the “Startup” tab in the sidebar.
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
                  onChange={(e) => updateRow(t.id, { command: e.target.value })}
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
    );
  },
);
