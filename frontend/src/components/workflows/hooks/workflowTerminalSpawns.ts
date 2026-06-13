// Maps workflow-run WS spawn events to the `addTerminal` arguments that open
// the step / task as a sidebar terminal. Pure: the hook calls these and feeds
// the result straight into TerminalsContext, so the label/serverId mapping is
// testable without a TerminalsContext.

import type { TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../../taskboard/lanes';

export type TerminalSpawn = {
  spec: Omit<TerminalSpec, 'id'>;
  // Second arg to `addTerminal` (focus). Step terminals focus; fanned-out task
  // terminals don't, to avoid yanking focus per-task during a start step.
  focus: boolean;
};

// A per-step `step-spawned` event → a focused terminal in the step directory.
export function stepSpawnedTerminal(
  ev: {
    stepIndex: number;
    command: string;
    cwd: string;
    serverId?: string;
  },
  projectPath: string,
): TerminalSpawn {
  return {
    spec: {
      label: `wf:step${ev.stepIndex + 1}`,
      cwd: ev.cwd,
      initialCommand: ev.command,
      projectPath,
      serverId: ev.serverId,
    },
    focus: true,
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
  },
  projectPath: string,
): TerminalSpawn {
  return {
    spec: {
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
