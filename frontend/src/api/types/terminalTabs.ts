// The durable terminal-tab registry (backend/src/terminalRegistry/) that lets
// the sidebar rebuild — and relaunch — its tabs after a backend restart, a
// closed browser, a Ctrl+C of the dev server, or a reboot. The record types
// are the backend's own (re-exported through backend/src/shared/wireTypes.ts);
// only the browser-side event union and settings enum are declared here.

import type {
  RestoreSummary as BackendRestoreSummary,
  TerminalEnded,
  TerminalRecord,
} from '../../../../backend/src/shared/wireTypes';

export type {
  AgentSessionRef,
  RestoreDropped,
  TerminalEndReason,
  TerminalEnded,
  TerminalOwner,
  TerminalRecord,
} from '../../../../backend/src/shared/wireTypes';

// `relaunchedIds` is optional on the wire for an older backend that predates it.
export type RestoreSummary = Omit<BackendRestoreSummary, 'relaunchedIds'> & {
  relaunchedIds?: string[];
};

export type TerminalTabsEvent =
  | { type: 'hello'; tabs: TerminalRecord[] }
  | { type: 'upsert'; projectPath: string; record: TerminalRecord }
  | { type: 'ended'; projectPath: string; id: string; ended: TerminalEnded }
  | { type: 'removed'; projectPath: string; id: string }
  | { type: 'restored'; projectPath: string; record: TerminalRecord; mode: 'adopted' | 'relaunched' }
  | { type: 'restore-failed'; projectPath: string; id: string; reason: string }
  | { type: 'restore-summary'; projectPath: string; summary: RestoreSummary };

export type RestoreTerminalsMode = 'always' | 'ask' | 'never';
