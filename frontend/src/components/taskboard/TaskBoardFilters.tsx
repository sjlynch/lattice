import type { PiMenuEntry, Task, TaskStatus } from '../../api';
import {
  buildHarnessOptions,
  encodeHarnessValue,
  selectedOptionTitle,
  type HarnessAvailability,
  type HarnessChoice,
} from '../../harnesses';
import type { Lane as LaneDef } from './lanes';

type TaskBoardFiltersProps = {
  lanes: LaneDef[];
  visibleLanes: Set<TaskStatus>;
  grouped: Record<TaskStatus, Task[]>;
  harness: HarnessChoice;
  piModel?: string;
  piMenu: PiMenuEntry[];
  selectHarness: (value: string) => void;
  harnessAvail: HarnessAvailability;
  onToggleLane: (id: TaskStatus) => void;
};

export function TaskBoardFilters({
  lanes,
  visibleLanes,
  grouped,
  harness,
  piModel,
  piMenu,
  selectHarness,
  harnessAvail,
  onToggleLane,
}: TaskBoardFiltersProps) {
  const harnessOptions = buildHarnessOptions({
    harnessAvail,
    piMenu,
    selected: { harness, piModel },
    includeInterleave: true,
  });
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
          value={encodeHarnessValue(harness, piModel)}
          onChange={(e) => selectHarness(e.target.value)}
          title={`Agent harness for running tasks: ${selectedOptionTitle(
            harnessOptions,
            encodeHarnessValue(harness, piModel),
          )}`}
        >
          {harnessOptions.map((option) => (
            <option key={option.value} value={option.value} title={option.title}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
