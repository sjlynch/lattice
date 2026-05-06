import type { TaskStatus } from '../../api';

// Lane metadata. The order here is the on-screen order of lanes.
export type Lane = { id: TaskStatus; label: string; color: string };

export const LANES: Lane[] = [
  { id: 'backlog', label: 'Backlog', color: '#7a8fa8' },
  { id: 'open', label: 'Open', color: '#6aa9ff' },
  { id: 'in_progress', label: 'In Progress', color: '#e7c986' },
  { id: 'ready_to_merge', label: 'Ready to Merge', color: '#5eead4' },
  { id: 'qa', label: 'QA', color: '#c89cff' },
  { id: 'done', label: 'Done', color: '#9ed28e' },
  { id: 'deleted', label: 'Deleted', color: '#7c8088' },
];

export const LANE_BY_ID: Record<TaskStatus, Lane> = LANES.reduce(
  (acc, l) => {
    acc[l.id] = l;
    return acc;
  },
  {} as Record<TaskStatus, Lane>,
);

// Custom drag MIME so cards drag-dropped from the task board don't get
// confused with native text drags onto unrelated targets.
export const DRAG_MIME = 'application/x-lattice-task';

export function shortLabel(title: string): string {
  const t = title.trim();
  return t.length > 18 ? t.slice(0, 17) + '…' : t;
}

// Decode a drag payload, which may be a single task ID string or a
// JSON-encoded array of IDs for multi-select drags.
export function parseDragPayload(raw: string): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return p as string[];
  } catch {}
  return [raw];
}
