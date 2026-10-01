import { useEffect, type Dispatch, type SetStateAction } from 'react';
import {
  subscribeWorkflowRuns,
  type WorkflowRun,
  type WorkflowRunEvent,
} from '../../../api';
import type { Ctx } from '../../../terminal/terminalTypes';
import {
  activeRunsFromHello,
  clearControlProgressForStep,
  clearStaleControlProgress,
  mergeRecoveringHello,
  removeKey,
  setControlProgress as applyControlProgress,
  upsertRun,
  type ControlProgressMap,
  type RunMap,
} from './workflowRunSync';
import {
  stepSpawnedTerminal,
  workflowTaskSpawnedTerminal,
} from './workflowTerminalSpawns';

type WorkflowRunSubscriptionArgs = {
  activeFolder: string;
  addTerminal: Ctx['addTerminal'];
  setActiveRuns: Dispatch<SetStateAction<RunMap>>;
  setControlProgress: Dispatch<SetStateAction<ControlProgressMap>>;
  addRecentRun: (run: WorkflowRun) => void;
};

type WorkflowRunEventHandlerArgs = Omit<
  WorkflowRunSubscriptionArgs,
  'activeFolder'
> & {
  projectPath: string;
};

export function handleWorkflowRunEvent(
  ev: WorkflowRunEvent,
  {
    projectPath,
    addTerminal,
    setActiveRuns,
    setControlProgress,
    addRecentRun,
  }: WorkflowRunEventHandlerArgs,
) {
  if (ev.type === 'hello') {
    // Authoritative server snapshot — replace activeRuns entirely. The hello is
    // emitted on initial connect and reconnect, so this is the recovery path
    // after socket drops. EXCEPT a `recovering` hello: the backend just
    // restarted and hasn't re-registered its persisted runs yet, so the list is
    // partial — merge it in and remove nothing (a removal would read as "the
    // run finished" and stop the workflow queue). The authoritative hello
    // follows once recovery lands.
    console.log(
      `[useWorkflowRuns] hello${ev.recovering ? ' (recovering)' : ''}: ` +
        `${ev.runs.length} active run(s) (project=${projectPath})`,
    );
    setActiveRuns((cur) =>
      ev.recovering ? mergeRecoveringHello(cur, ev.runs) : activeRunsFromHello(ev.runs),
    );
  } else if (ev.type === 'started' || ev.type === 'progress') {
    setActiveRuns((cur) => upsertRun(cur, ev.run));
    setControlProgress((cur) =>
      clearStaleControlProgress(cur, ev.run.id, ev.run.currentStepIndex,
        ev.run.activeStepIndices?.filter((i) => ev.run.stepStates?.[i]?.phase !== 'completed')),
    );
  } else if (
    ev.type === 'completed' ||
    ev.type === 'errored' ||
    ev.type === 'cancelled'
  ) {
    if (ev.type !== 'completed') {
      console.log(
        `[useWorkflowRuns] run ${ev.run.id} ${ev.type} ` +
          `(workflow=${ev.run.workflowName}, error=${ev.run.error ?? 'none'})`,
      );
    }
    setActiveRuns((cur) => removeKey(cur, ev.run.id));
    setControlProgress((cur) => removeKey(cur, ev.run.id));
    addRecentRun(ev.run);
  } else if (ev.type === 'step-spawned') {
    const { spec, focus } = stepSpawnedTerminal(ev, projectPath);
    addTerminal(spec, focus);
    // The step's pre-run tool wait (if any) is over once its terminal exists.
    setControlProgress((cur) => clearControlProgressForStep(cur, ev.runId, ev.stepIndex));
  } else if (ev.type === 'workflow-task-spawned') {
    const { spec, focus } = workflowTaskSpawnedTerminal(ev, projectPath);
    addTerminal(spec, focus);
  } else if (ev.type === 'step-control-progress') {
    setControlProgress((cur) => applyControlProgress(cur, ev));
  }
}

// Subscribes to `/ws/workflow-runs` and routes each event through focused state
// reducers / terminal-spawn mappers. Clearing project-scoped state on every
// folder change stays here so the top-level hook remains a small composition of
// lifecycle helpers.
export function useWorkflowRunSubscription({
  activeFolder,
  addTerminal,
  setActiveRuns,
  setControlProgress,
  addRecentRun,
}: WorkflowRunSubscriptionArgs) {
  useEffect(() => {
    // Active runs are project-scoped. Drop the previous project's runs (and any
    // in-flight control progress) immediately on EVERY folder change — matching
    // the saved-list (`useWorkflowList`) and recent-runs (`useWorkflowRecentRuns`)
    // per-project clearing — so project A's runs never leak into project B in
    // the window before B's WS hello / recovery fetch repopulates from scratch.
    // Leaking them stalls B's sequential queue (the leaked count keeps the gate
    // waiting) and shows A's running workflow under B's navbar chip.
    setActiveRuns({});
    setControlProgress({});
    if (!activeFolder) return;

    let cancelled = false;
    const unsub = subscribeWorkflowRuns(activeFolder, (ev) => {
      if (cancelled) return;
      handleWorkflowRunEvent(ev, {
        projectPath: activeFolder,
        addTerminal,
        setActiveRuns,
        setControlProgress,
        addRecentRun,
      });
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [
    activeFolder,
    addTerminal,
    setActiveRuns,
    setControlProgress,
    addRecentRun,
  ]);
}
