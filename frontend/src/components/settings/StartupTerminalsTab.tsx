import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
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

type StartupTerminalsDraft = {
  addRow: () => void;
  draft: StartupTerminal[];
  getCleanedTerminals: () => StartupTerminal[];
  removeRow: (id: string) => void;
  updateRow: (id: string, patch: Partial<StartupTerminal>) => void;
};

function useStartupTerminalsDraft(
  open: boolean,
  startupTerminals: StartupTerminal[],
): StartupTerminalsDraft {
  const [draft, setDraft] = useState<StartupTerminal[]>(startupTerminals);

  // Reset the local edit buffer whenever the dialog opens or the upstream
  // list changes (e.g. user just hit Restart and the list was re-saved).
  useEffect(() => {
    if (open) setDraft(startupTerminals);
  }, [open, startupTerminals]);

  const addRow = useCallback(() => {
    setDraft((current) => [
      ...current,
      { id: makeId(), label: `startup ${current.length + 1}`, command: '' },
    ]);
  }, []);

  const removeRow = useCallback((id: string) => {
    setDraft((current) => current.filter((t) => t.id !== id));
  }, []);

  const updateRow = useCallback((id: string, patch: Partial<StartupTerminal>) => {
    setDraft((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const getCleanedTerminals = useCallback(
    () => cleanStartupTerminals(draft),
    [draft],
  );

  return {
    addRow,
    draft,
    getCleanedTerminals,
    removeRow,
    updateRow,
  };
}

type StartupTerminalRowProps = {
  terminal: StartupTerminal;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<StartupTerminal>) => void;
};

function StartupTerminalRow({ terminal, onRemove, onUpdate }: StartupTerminalRowProps) {
  return (
    <div className="startup-row">
      <input
        className="text-input startup-label"
        placeholder="label"
        value={terminal.label}
        onChange={(e) => onUpdate(terminal.id, { label: e.target.value })}
        spellCheck={false}
      />
      <input
        className="text-input startup-command"
        placeholder="command (e.g. npm run dev)"
        value={terminal.command}
        onChange={(e) => onUpdate(terminal.id, { command: e.target.value })}
        spellCheck={false}
      />
      <button
        className="icon-btn sm"
        onClick={() => onRemove(terminal.id)}
        title="Remove"
        aria-label="Remove startup terminal"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export const StartupTerminalsTab = forwardRef<StartupTerminalsTabHandle, Props>(
  function StartupTerminalsTab({ active, open, startupTerminals }, ref) {
    const { addRow, draft, getCleanedTerminals, removeRow, updateRow } =
      useStartupTerminalsDraft(open, startupTerminals);

    useImperativeHandle(
      ref,
      () => ({ getCleanedTerminals }),
      [getCleanedTerminals],
    );

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
            {draft.map((terminal) => (
              <StartupTerminalRow
                key={terminal.id}
                terminal={terminal}
                onRemove={removeRow}
                onUpdate={updateRow}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
