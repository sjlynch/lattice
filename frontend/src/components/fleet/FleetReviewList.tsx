import { useState } from 'react';
import { fetchFleetTask, type FleetTask } from '../../api';
import { reviewBadge } from './fleetDerive';

type Props = { tasks: FleetTask[]; project: string; machine?: string };

// Finished work waiting on a human in one project: each line shows the
// second opinion's verdict; expanding it loads the task's summary (what the
// agent says it did, and its Spec gaps).
export function FleetReviewList({ tasks, project, machine }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  if (!tasks.length) return null;
  const toggle = (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (text[id] === undefined) {
      fetchFleetTask(id, project, machine)
        .then((t) => setText((m) => ({ ...m, [id]: (t.summary ?? '').trim() || '(no summary yet)' })))
        .catch((e) => setText((m) => ({ ...m, [id]: `Could not load: ${e instanceof Error ? e.message : String(e)}` })));
    }
  };
  return (
    <div className="fleet-review">
      {tasks.map((t) => {
        const badge = reviewBadge(t);
        return (
          <div key={t.id}>
            <button className="fleet-review-line" onClick={() => toggle(t.id)} title={t.review?.reason ?? t.title} aria-expanded={open === t.id}>
              <span className={`fleet-review-lane lane-${t.status}`}>{t.status === 'qa' ? 'QA' : 'Ready'}</span>
              <span className="fleet-ellipsis">{t.title}</span>
              {badge && <span className={`fleet-review-badge tone-${badge.tone}`}>{badge.text}</span>}
            </button>
            {open === t.id && <pre className="fleet-review-summary">{text[t.id] ?? 'Loading…'}</pre>}
          </div>
        );
      })}
    </div>
  );
}
