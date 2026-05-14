import type { RefObject } from 'react';
import type { TerminalSpec } from '../../TerminalsContext';

type TabContextMenuState = {
  termId: string;
  x: number;
  y: number;
};

type Props = {
  menu: TabContextMenuState | null;
  visibleTerminals: TerminalSpec[];
  menuRef: RefObject<HTMLDivElement | null>;
  onCloseTabsToLeft: (termId: string) => void;
  onCloseTabsToRight: (termId: string) => void;
  onCloseOtherTabs: (termId: string) => void;
};

export function TabContextMenu({
  menu,
  visibleTerminals,
  menuRef,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
}: Props) {
  if (!menu) return null;

  const idx = visibleTerminals.findIndex((t) => t.id === menu.termId);
  const hasLeft = idx > 0;
  const hasRight = idx >= 0 && idx < visibleTerminals.length - 1;
  const hasOthers = visibleTerminals.length > 1 && idx >= 0;

  return (
    <div
      ref={menuRef}
      className="popover"
      style={{ position: 'fixed', left: menu.x, top: menu.y }}
      role="menu"
    >
      <div
        className={`popover-item${!hasLeft ? ' disabled' : ''}`}
        role="menuitem"
        onClick={hasLeft ? () => onCloseTabsToLeft(menu.termId) : undefined}
      >
        Close Tabs to the Left
      </div>
      <div
        className={`popover-item${!hasRight ? ' disabled' : ''}`}
        role="menuitem"
        onClick={hasRight ? () => onCloseTabsToRight(menu.termId) : undefined}
      >
        Close Tabs to the Right
      </div>
      <div
        className={`popover-item${!hasOthers ? ' disabled' : ''}`}
        role="menuitem"
        onClick={hasOthers ? () => onCloseOtherTabs(menu.termId) : undefined}
      >
        Close All Other Tabs
      </div>
    </div>
  );
}
