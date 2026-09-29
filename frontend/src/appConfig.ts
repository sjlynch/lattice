export const APP_CONFIG = {
  storage: {
    activeFolderSessionKey: 'lattice.activeFolder',
    hiddenExtsKeyPrefix: 'lattice.hiddenExts.',
  },
  sidebar: {
    defaultWidth: 380,
    minWidth: 240,
    // The graph keeps at least this much width beside the sidebar; dragging
    // the resizer into that last strip snaps the sidebar to the full page
    // width and hides the graph (useSidebarWidth `sidebarMaximized`).
    minGraphWidth: 200,
  },
  scanRetry: {
    initialDelayMs: 300,
    maxDelayMs: 5000,
    backoffFactor: 2,
  },
} as const;
