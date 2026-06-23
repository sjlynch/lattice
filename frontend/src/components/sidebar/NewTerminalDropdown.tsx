import { ChevronDown, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PiMenuEntry } from '../../api';

export type ShellKind = 'claude' | 'claude-yolo' | 'pi' | 'codex' | 'terminal';

const SHELL_KIND_BUTTON_TITLES: Record<ShellKind, string> = {
  claude: 'New Claude terminal',
  'claude-yolo': 'New Dangerous Claude terminal',
  pi: 'New Pi terminal',
  codex: 'New Codex terminal',
  terminal: 'New terminal',
};

type Props = {
  defaultKind: ShellKind;
  // The curated "Pi — X" model menu (GET /api/pi-models .menu). Rendered as
  // sub-items beneath "Pi"; each spawns `pi --model "<pattern>"`.
  piMenu: PiMenuEntry[];
  onNewTerminal: (kind: ShellKind, piModel?: string) => void;
};

export function NewTerminalDropdown({ defaultKind, piMenu, onNewTerminal }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const choose = useCallback(
    (kind: ShellKind, piModel?: string) => {
      setMenuOpen(false);
      onNewTerminal(kind, piModel);
    },
    [onNewTerminal],
  );

  return (
    <div className="sidebar-new" ref={menuRef}>
      <button
        className="icon-btn sm"
        onClick={() => onNewTerminal(defaultKind)}
        title={SHELL_KIND_BUTTON_TITLES[defaultKind]}
        aria-label={SHELL_KIND_BUTTON_TITLES[defaultKind]}
      >
        <Plus size={14} />
      </button>
      <button
        className="icon-btn sm sidebar-new-chevron"
        onClick={() => setMenuOpen((v) => !v)}
        title="Choose terminal type"
        aria-label="Choose terminal type"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <ChevronDown size={12} />
      </button>
      {menuOpen && (
        <div className="popover sidebar-new-menu" role="menu">
          <div
            className="popover-item"
            role="menuitem"
            onClick={() => choose('claude')}
          >
            Claude
          </div>
          <div
            className="popover-item"
            role="menuitem"
            onClick={() => choose('claude-yolo')}
          >
            Dangerous Claude
          </div>
          <div
            className="popover-item"
            role="menuitem"
            onClick={() => choose('pi')}
          >
            Pi
          </div>
          {piMenu.map((m) => (
            <div
              key={m.pattern}
              className="popover-item popover-item-sub"
              role="menuitem"
              title={m.pattern}
              onClick={() => choose('pi', m.pattern)}
            >
              Pi — {m.label}
            </div>
          ))}
          <div
            className="popover-item"
            role="menuitem"
            onClick={() => choose('codex')}
          >
            Codex
          </div>
          <div
            className="popover-item"
            role="menuitem"
            onClick={() => choose('terminal')}
          >
            Terminal
          </div>
        </div>
      )}
    </div>
  );
}
