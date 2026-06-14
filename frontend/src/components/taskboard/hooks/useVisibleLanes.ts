import { useCallback, useState } from 'react';
import { type TaskStatus } from '../../../api';
import { LANES } from '../lanes';

// Lane visibility toggle state for the filter chips. Defaults to every lane
// visible; toggling flips one lane in/out of the set.
export function useVisibleLanes() {
  const [visibleLanes, setVisibleLanes] = useState<Set<TaskStatus>>(
    () => new Set(LANES.map((lane) => lane.id)),
  );

  const toggleLane = useCallback((id: TaskStatus) => {
    setVisibleLanes((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return { visibleLanes, toggleLane };
}
