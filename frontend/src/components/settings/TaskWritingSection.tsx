import { useEffect, useId, useState } from 'react';
import { fetchRecentSpecGaps, type RecentSpecGap } from '../../api';
import { SettingsSection } from './SettingsSection';
import { SettingsInfo } from './SettingsInfo';
import type { useTaskWritingDraft } from './useTaskWritingDraft';

type Props = {
  open: boolean;
  activeFolder: string;
  draft: ReturnType<typeof useTaskWritingDraft>;
};

export function TaskWritingSection({ open, activeFolder, draft }: Props) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [gaps, setGaps] = useState<RecentSpecGap[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setExpanded(false);
    setGaps(null);
    setFailed(false);
  }, [open, activeFolder]);
  useEffect(() => {
    if (!open || !expanded || !activeFolder) return;
    let cancelled = false;
    setGaps(null);
    setFailed(false);
    fetchRecentSpecGaps(activeFolder).then((entries) => {
      if (!cancelled) setGaps(entries);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [open, expanded, activeFolder]);

  return (
    <SettingsSection title="Task writing">
      <div className="settings-section-title-row">
        <label className="task-writing-label" htmlFor={id}>Rules for task descriptions</label>
        <SettingsInfo label="About task-writing rules">Enter one rule per line.</SettingsInfo>
      </div>
      <textarea
        id={id}
        className="text-input task-writing-rules"
        rows={5}
        value={draft.rulesText}
        onChange={(e) => draft.setRulesText(e.target.value)}
        aria-describedby={`${id}-help`}
      />
      <div id={`${id}-help`} className="settings-section-sub">
        Every planning step's brief lists these rules. Up to 12 rules, 300 characters each.
      </div>
      <label className="settings-checkbox-row">
        <input type="checkbox" checked={draft.showGaps} onChange={(e) => draft.setShowGaps(e.target.checked)} />
        <span>Show planners what implementers recently had to guess</span>
      </label>
      <div className="settings-section-sub">
        Adds the newest Spec gaps from task summaries to every planning step's brief.
      </div>
      <details className="task-writing-recent" open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>Recent Spec gaps</summary>
        {expanded && (failed ? (
          <div className="error-msg">Couldn't load Spec gaps.</div>
        ) : gaps === null ? (
          <div className="settings-empty">Loading…</div>
        ) : gaps.length === 0 ? (
          <div className="settings-empty">No Spec gaps reported yet. Task agents add them at the end of their summaries.</div>
        ) : (
          <ul className="task-writing-gap-list">
            {gaps.map((entry, index) => (
              <li key={`${entry.taskId}-${index}`}>
                <div>{entry.gap}</div>
                <div className="settings-section-sub">{entry.title}</div>
              </li>
            ))}
          </ul>
        ))}
      </details>
    </SettingsSection>
  );
}
