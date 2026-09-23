// The "recently merged tasks" section of the Run tests brief (R6): tasks that
// reached QA or Done since the last Run tests finished (`lastFinishedAt` in
// run-tests.json), falling back to "since this workflow run started" when no
// Run tests has finished yet. Newest first, capped at 30, each as its title plus
// the first three non-empty lines of its description — a starting point for
// where to look, not the list of what to run.

import type { Task } from '../../tasks.js';

export const RECENT_TASKS_LIMIT = 30;
const DESCRIPTION_LINES = 3;
const LINE_MAX_CHARS = 200;

// When the task landed in QA/Done: `mergedAt` (set on the qa transition), else
// `doneAt`, else its last update.
function landedAt(task: Task): number {
  return task.mergedAt ?? task.doneAt ?? task.updatedAt ?? task.createdAt;
}

export function selectRecentlyMergedTasks(tasks: readonly Task[], since: number): Task[] {
  return tasks
    .filter((t) => (t.status === 'qa' || t.status === 'done') && landedAt(t) >= since)
    .sort((a, b) => landedAt(b) - landedAt(a))
    .slice(0, RECENT_TASKS_LIMIT);
}

function clip(line: string): string {
  return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line;
}

export function renderRecentTasksBlock(tasks: readonly Task[], sinceLabel: string): string {
  if (tasks.length === 0) {
    return `_No tasks reached QA or Done ${sinceLabel}. Run the whole suite._`;
  }
  const lines = [`${tasks.length} task(s) reached QA or Done ${sinceLabel}:`, ''];
  for (const t of tasks) {
    lines.push(`- **${clip(t.title.replace(/\s+/g, ' ').trim() || '(untitled)')}** (${t.status})`);
    const desc = (t.description ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, DESCRIPTION_LINES);
    for (const d of desc) lines.push(`  > ${clip(d)}`);
  }
  return lines.join('\n');
}
