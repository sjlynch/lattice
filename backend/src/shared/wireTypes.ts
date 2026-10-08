// Types that cross the HTTP/WS boundary, re-exported for the frontend
// (`frontend/src/api/types/*` re-export these instead of hand-copying them).
// Type-only: nothing here exists at runtime. Every module these resolve to must
// stay node-free — the frontend type-checks them (`sharedFolderBoundary` test).
export type { Task, TaskStatus } from '../taskCache/types.js';
export type {
  AgentSessionRef,
  AgentSessionSource,
  RestoreDropped,
  RestoreSummary,
  TerminalEndReason,
  TerminalEnded,
  TerminalLaunch,
  TerminalOwner,
  TerminalRecord,
} from '../terminalRegistry/types.js';
