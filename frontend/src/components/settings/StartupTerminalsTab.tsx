import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { StartupTerminal } from '../../api';

type Props = {
  active: boolean;
  open: boolean;
  startupTerminals: StartupTerminal[];
};

export type StartupTerminalsTabHandle = {
  getCleanedTerminals: () => StartupTerminal[];
  // True once the user edited the list since the draft was last seeded. Save
  // writes `startupTerminals` only when this is set or the project's settings
  // have loaded — an untouched draft seeded before the load holds `[]`, not
  // the project's list.
  isTouched: () => boolean;
};

function makeId(): string {
  return `st_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Field access is defensive because this ran on data the UI didn't author: a
// row hand-written through `PATCH /api/settings` (agents do this) that guessed
// `{name, command}` had no `label`, and `t.label.trim()` threw during the
// dirty-check the dialog runs on open — so the Settings dialog for that project
// wouldn't render at all, and the one UI that could have repaired the row was
// the one the row had broken. The backend now coerces the shape at its I/O
// boundary (userSettings/storage.ts), which is the real fix; this is the guard
// that keeps a future bad row a bad row instead of an unopenable dialog.
export function cleanStartupTerminals(terminals: StartupTerminal[]): StartupTerminal[] {
  return terminals
    .map((t) => ({
      id: t?.id || makeId(),
      label: t?.label?.trim() || 'startup',
      command: t?.command?.trim() ?? '',
    }))
    .filter((t) => t.command.length > 0);
}

type StartupTerminalsDraft = {
  addRow: () => void;
  draft: StartupTerminal[];
  getCleanedTerminals: () => StartupTerminal[];
  isTouched: () => boolean;
  removeRow: (id: string) => void;
  updateRow: (id: string, patch: Partial<StartupTerminal>) => void;
};

function useStartupTerminalsDraft(
  open: boolean,
  startupTerminals: StartupTerminal[],
): StartupTerminalsDraft {
  const [draft, setDraft] = useState<StartupTerminal[]>(startupTerminals);
  const touchedRef = useRef(false);

  // Reset the local edit buffer whenever the dialog opens or the upstream
  // list changes (e.g. user just hit Restart and the list was re-saved).
  useEffect(() => {
    if (!open) return;
    setDraft(startupTerminals);
    touchedRef.current = false;
  }, [open, startupTerminals]);

  const addRow = useCallback(() => {
    touchedRef.current = true;
    setDraft((current) => [
      ...current,
      { id: makeId(), label: `startup ${current.length + 1}`, command: '' },
    ]);
  }, []);

  const removeRow = useCallback((id: string) => {
    touchedRef.current = true;
    setDraft((current) => current.filter((t) => t.id !== id));
  }, []);

  const updateRow = useCallback((id: string, patch: Partial<StartupTerminal>) => {
    touchedRef.current = true;
    setDraft((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const getCleanedTerminals = useCallback(
    () => cleanStartupTerminals(draft),
    [draft],
  );

  const isTouched = useCallback(() => touchedRef.current, []);

  return {
    addRow,
    draft,
    getCleanedTerminals,
    isTouched,
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
    const { addRow, draft, getCleanedTerminals, isTouched, removeRow, updateRow } =
      useStartupTerminalsDraft(open, startupTerminals);

    useImperativeHandle(
      ref,
      () => ({ getCleanedTerminals, isTouched }),
      [getCleanedTerminals, isTouched],
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
