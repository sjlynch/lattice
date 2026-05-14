export function generateTaskId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function generateWorkflowId(): string {
  return `wf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

let terminalSessionCounter = 0;

export function createTerminalSessionId(): string {
  // Counter + timestamp so two sessions created in the same millisecond
  // can never collide. Math.random() suffix keeps the id short while
  // still being unguessable at a glance.
  terminalSessionCounter += 1;
  return `tty_${Date.now()}_${terminalSessionCounter}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function generateMergeRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function generateWorkflowPromptCustomizationId(): string {
  return `wfpc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
