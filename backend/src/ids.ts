export function generateTaskId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function generateMergeRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
