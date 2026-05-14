import type { HarnessAvailability, Task, TaskStatus } from '../../api';
import type { HarnessChoice } from './hooks/useHarnessSelector';
import type { Lane as LaneDef } from './lanes';

type TaskBoardFiltersProps = {
  lanes: LaneDef[];
  visibleLanes: Set<TaskStatus>;
  grouped: Record<TaskStatus, Task[]>;
  harness: HarnessChoice;
  setHarness: (value: HarnessChoice) => void;
  harnessAvail: HarnessAvailability;
  onToggleLane: (id: TaskStatus) => void;
};

export function TaskBoardFilters({
  lanes,
  visibleLanes,
  grouped,
  harness,
  setHarness,
  harnessAvail,
  onToggleLane,
}: TaskBoardFiltersProps) {
  return (
    <div className="taskboard-filters">
      {lanes.map((lane) => {
        const on = visibleLanes.has(lane.id);
        return (
          <button
            key={lane.id}
            className={`taskboard-filter ${on ? '' : 'off'}`}
            onClick={() => onToggleLane(lane.id)}
            title={on ? `Hide ${lane.label}` : `Show ${lane.label}`}
          >
            <span
              className="taskboard-lane-dot"
              style={{ background: lane.color }}
            />
            {lane.label}
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-tertiary)',
                marginLeft: 2,
              }}
            >
              {grouped[lane.id].length}
            </span>
          </button>
        );
      })}
      {(harnessAvail.pi || harnessAvail.codex) && (
        <select
          className="taskboard-harness-select"
          value={harness}
          onChange={(e) => setHarness(e.target.value as HarnessChoice)}
          title="Agent harness for running tasks"
        >
          <option value="claude">Claude</option>
          {harnessAvail.pi && <option value="pi">Pi</option>}
          {harnessAvail.codex && <option value="codex">Codex</option>}
          {harnessAvail.pi && <option value="interleave">Interleave</option>}
        </select>
      )}
    </div>
  );
}
