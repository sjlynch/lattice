import { WebSocketServer } from 'ws';
import { canonicalProjectPath } from '../../projectPath.js';
import { subscribeTerminalRegistry, terminalRegistry } from '../../terminalRegistry/store.js';
import type { TerminalRegistryEvent } from '../../terminalRegistry/types.js';
import { buildProjectWss } from '../projectEndpoint.js';

// `/ws/terminal-tabs?project=` — the durable terminal-tab registry, live.
//   { type: 'hello', tabs }              initial snapshot (incl. ended-but-kept)
//   { type: 'upsert', record }           a record was created / changed
//   { type: 'ended', id, ended }         a tab ended (reason inside)
//   { type: 'removed', id }              a record is gone for good
//   { type: 'restored', record, mode }   restore adopted / relaunched a tab
//   { type: 'restore-failed', id, reason }
//   { type: 'restore-summary', summary } a restore pass finished
export function buildTerminalTabsWss(): WebSocketServer {
  return buildProjectWss<TerminalRegistryEvent>({
    initial: async (project) => ({
      type: 'hello',
      tabs: await terminalRegistry.list(project, { includeEnded: true }),
    }),
    initialError: 'ignore',
    subscribe: (listener) => subscribeTerminalRegistry(listener),
    projectFromEvent: (ev) => canonicalProjectPath(ev.projectPath),
    payloadFromEvent: (ev) => ev,
  });
}
