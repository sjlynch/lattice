// Durable terminal-tab registry — the public facade over ./terminalRegistry/
// (see its CLAUDE.md).
export type * from './terminalRegistry/types.js';
export {
  terminalRegistry,
  subscribeTerminalRegistry,
  terminalsFile,
  deserializeTerminalRecord,
  deserializeTerminalRecords,
  TerminalRegistryStore,
} from './terminalRegistry/store.js';
export { assignHarnessSessionId, mintAgentSessionId } from './terminalRegistry/sessionIdentity.js';
export { buildRestoreCommand, RESTORE_NUDGE } from './terminalRegistry/restoreCommand.js';
export { restoreProjectTerminals } from './terminalRegistry/restore.js';
export { startTerminalRegistryWatch, reconcileExitedTerminals, readLiveSessions } from './terminalRegistry/watch.js';
export { scheduleCodexDiscovery } from './terminalRegistry/codexDiscovery.js';
export { detectInterruption } from './terminalRegistry/interruption.js';
export { taskTerminalLabel, mergeTerminalLabel, shortLabel } from './terminalRegistry/labels.js';
