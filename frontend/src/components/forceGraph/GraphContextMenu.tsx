import { MENU_ITEMS, type MenuItemDef } from './menu';

type Props = {
  position: { x: number; y: number } | null;
  onPick: (item: MenuItemDef) => void;
};

// Right-click popover anchored to container-local coords. Returns null
// when there's no active menu so the caller can render unconditionally.
export function GraphContextMenu({ position, onPick }: Props) {
  if (!position) return null;
  return (
    <div
      className="popover graph-context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      {MENU_ITEMS.map((item) => (
        <div
          key={item.verb}
          className="popover-item"
          role="menuitem"
          onClick={() => onPick(item)}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
