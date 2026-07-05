// Barrel for the terminal-tab pure functions. The implementation is split so
// each half can be reasoned about on its own:
//   - terminalListOps.ts     — pure terminal-list mutations (add / remove /
//                              close planning / server / status / rename /
//                              reorder) and the id generator.
//   - terminalActivePolicy.ts — active-id fallback policy (pickInitialActiveId,
//                              pickActiveAfterAdd / Close / CloseMany) plus the
//                              project-scoped panel grouping it depends on.
// Re-exported from here so the public import surface (`./terminalState`) stays
// stable for TerminalsContext and the tests.
export {
  newTerminalId,
  addTerminalToList,
  removeTerminalFromList,
  removeTerminalsFromList,
  terminalIdsForTask,
  planCloseTerminals,
  setServerIdInList,
  setStatusInList,
  renameTerminalInList,
  reorderTerminalInList,
} from './terminalListOps';

export {
  pickInitialActiveId,
  pickActiveAfterAdd,
  pickActiveAfterClose,
  pickActiveAfterCloseMany,
} from './terminalActivePolicy';
