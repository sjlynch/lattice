// Tracks projects that currently have a per-card manual merge in flight.
// Prevents two simultaneous per-card merge clicks from racing on
// fastForwardMain (which mutates main's HEAD). The merge-run worker is
// already sequential; this guard covers the manual path.
const projectMergesActive = new Set<string>();

export function isProjectManualMergeActive(projectPath: string): boolean {
  return projectMergesActive.has(projectPath);
}

export function markProjectManualMergeActive(projectPath: string): void {
  projectMergesActive.add(projectPath);
}

export function clearProjectManualMergeActive(projectPath: string): void {
  projectMergesActive.delete(projectPath);
}
