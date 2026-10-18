import type { HarnessAvailability, PiMenuEntry } from '../../api';
import {
  buildHarnessOptions,
  decodeHarnessValue,
  encodeHarnessValue,
  isAgentHarness,
  selectedOptionTitle,
  type AgentHarness,
} from '../../harnesses';

const PROJECT_DEFAULT = 'project-default';

// A Start step's task harness ("Pi — X" rows included): which harness the
// tasks it starts run on. "Tasks: project default" = the project's task
// harness setting, as before. A run's harness override still wins.
export function StartTasksHarnessSelect({
  harnessAvail,
  piMenu,
  harness,
  piModel,
  onChange,
  defaultLabel = 'Tasks: project default',
}: {
  harnessAvail: HarnessAvailability;
  piMenu: PiMenuEntry[];
  harness?: AgentHarness;
  piModel?: string;
  onChange: (harness: AgentHarness | undefined, piModel: string | undefined) => void;
  defaultLabel?: string;
}) {
  const options = [
    { value: PROJECT_DEFAULT, label: defaultLabel },
    ...buildHarnessOptions({
      harnessAvail,
      piMenu,
      selected: harness ? { harness, piModel } : { harness: 'claude' },
      includeInterleave: false,
    }).map((o) => ({ ...o, label: `Tasks: ${o.label}` })),
  ];
  const value = harness ? encodeHarnessValue(harness, piModel) : PROJECT_DEFAULT;
  return (
    <select
      className="workflows-step-harness"
      value={value}
      onChange={(e) => {
        if (e.target.value === PROJECT_DEFAULT) return onChange(undefined, undefined);
        const sel = decodeHarnessValue(e.target.value);
        if (isAgentHarness(sel.harness)) onChange(sel.harness, sel.harness === 'pi' ? sel.piModel : undefined);
      }}
      title={`Harness for the tasks this step starts: ${selectedOptionTitle(options, value)}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} title={'title' in o ? o.title : undefined}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
