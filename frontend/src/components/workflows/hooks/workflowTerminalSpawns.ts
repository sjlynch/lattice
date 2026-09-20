// Maps workflow-run WS spawn events to the `addTerminal` arguments that open
// the step / task as a sidebar terminal. Pure: the hook calls these and feeds
// the result straight into TerminalsContext, so the label/serverId mapping is
// testable without a TerminalsContext.

import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { shortLabel } from '../../taskboard/lanes';

export type TerminalSpawn = {
  spec: AddTerminalSpec;
  // Second arg to `addTerminal` (focus). Neither step nor fanned-out task
  // terminals steal focus from a currently-focused tab — `addTerminal`'s
  // `pickActiveAfterAdd` still focuses the spawn when nothing is focused
  // (so a run from an empty sidebar isn't left on the empty state), but
  // preserves the active tab when the user is already in one.
  focus: boolean;
};

// A per-step `step-spawned` event → a terminal in the step directory.
//
// `focus: false` so a running workflow advancing to its next step doesn't yank
// the user away from whatever terminal tab they're currently watching. The
// step terminal still becomes active when there's nothing focused yet (the
// first step of a run started from an empty sidebar), because
// `pickActiveAfterAdd` focuses a `focus: false` spawn only when `activeId` is
// null. It stays discoverable in the Terminals panel either way.
export function stepSpawnedTerminal(
  ev: {
    stepIndex: number;
    command: string;
    cwd: string;
    serverId?: string;
    terminalId?: string;
  },
  projectPath: string,
): TerminalSpawn {
  return {
    spec: {
      id: ev.terminalId,
      label: `wf:step${ev.stepIndex + 1}`,
      cwd: ev.cwd,
      initialCommand: ev.command,
      projectPath,
      serverId: ev.serverId,
    },
    focus: false,
  };
}

// A start-control step fans out one task agent per Open task. Tagging with
// taskId lets useTaskTerminalCleanup auto-close it when the task moves out of
// in_progress. Unfocused so a wide fan-out doesn't steal focus repeatedly.
export function workflowTaskSpawnedTerminal(
  ev: {
    taskId: string;
    title: string;
    command: string;
    cwd: string;
    serverId?: string;
    terminalId?: string;
  },
  projectPath: string,
): TerminalSpawn {
  return {
    spec: {
      id: ev.terminalId,
      label: shortLabel(ev.title),
      cwd: ev.cwd,
      initialCommand: ev.command,
      taskId: ev.taskId,
      projectPath,
      serverId: ev.serverId,
    },
    focus: false,
  };
}
