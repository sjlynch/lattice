export const APP_CONFIG = {
  storage: {
    activeFolderSessionKey: 'lattice.activeFolder',
    hiddenExtsKeyPrefix: 'lattice.hiddenExts.',
  },
  sidebar: {
    defaultWidth: 380,
    minWidth: 240,
    maxWidth: 1200,
    maxViewportRatio: 0.8,
  },
  scanRetry: {
    initialDelayMs: 300,
    maxDelayMs: 5000,
    backoffFactor: 2,
  },
} as const;
