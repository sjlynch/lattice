import type { Task, TaskStatus } from '../../api';
import {
  availableHarnessChoices,
  harnessLabel,
  type HarnessAvailability,
  type HarnessChoice,
} from '../../harnesses';
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
  const harnessOptions = availableHarnessChoices(harnessAvail, harness);
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
      {harnessOptions.length > 1 && (
        <select
          className="taskboard-harness-select"
          value={harness}
          onChange={(e) => setHarness(e.target.value as HarnessChoice)}
          title="Agent harness for running tasks"
        >
          {harnessOptions.map((option) => (
            <option key={option} value={option}>
              {harnessLabel(option)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
