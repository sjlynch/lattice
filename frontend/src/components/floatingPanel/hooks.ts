// Re-export barrel: FloatingPanel's hooks live one concern per module (see
// CLAUDE.md); existing imports of `floatingPanel/hooks` keep working.
export { useFloatingPanelState } from './usePanelGeometry';
export { panelForEscape, useFloatingPanelEscape } from './panelEscapeStack';
export { usePanelDrag, usePanelResize } from './usePanelDragResize';
