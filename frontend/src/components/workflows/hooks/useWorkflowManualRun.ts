import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workflow, WorkflowRun } from '../../../api';
import type { EditorRunResult, StartOutcome } from './useWorkflowRunActions';

type Args = {
  // Runs the backend considers active for the project (the `/ws/workflow-runs`
  // view). Read through a ref at click time, so the callbacks stay stable.
  activeRuns: Record<string, WorkflowRun>;
  // The saved workflow loaded in the editor, if any. An editor ▶ Run holds the
  // in-flight guard for it too, so the saved-list ▶ of the same workflow can't
  // start it a second time while the editor's start is pending.
  editorWorkflowId?: string | null;
  runWorkflow: (workflowId: string) => Promise<StartOutcome>;
  runEditorWorkflow: () => Promise<EditorRunResult>;
  enqueueWorkflow: (workflowId: string) => boolean;
  enqueueWorkflowDefinition: (wf: Workflow) => boolean;
  enqueueEditorWorkflow: () => Promise<boolean>;
  startQueuedWorkflows: () => void;
  // The workflow panel's toast slot.
  notify: (msg: string) => void;
};

// Name of the run a new start would wait behind: the oldest active run (a
// project runs one workflow at a time, so normally the only one). Null when
// this tab doesn't know of one yet — the backend's 409 can beat the WS event.
function activeWorkflowName(activeRuns: Record<string, WorkflowRun>): string | null {
  const oldest = Object.values(activeRuns).sort((a, b) => a.startedAt - b.startedAt)[0];
  return oldest ? oldest.workflowName : null;
}

// In-flight key for the editor's ▶ Run, which may start a never-saved draft
// that has no workflow id yet.
const EDITOR_KEY = 'editor:';

// The manual ▶ Run buttons (editor footer + saved-list row). A project runs one
// workflow at a time — the backend 409s a second start — so when a run is
// already active (known locally, or learned from the 409) the workflow goes on
// the sequential queue instead, with a "Queued behind <name>" toast. The queue
// is started too: the click is an explicit "run this", so the entry must not
// sit idle behind a queue the user stopped earlier (an enqueue only auto-starts
// the queue when the active run isn't queue-owned).
export function useWorkflowManualRun({
  activeRuns,
  editorWorkflowId = null,
  runWorkflow,
  runEditorWorkflow,
  enqueueWorkflow,
  enqueueWorkflowDefinition,
  enqueueEditorWorkflow,
  startQueuedWorkflows,
  notify,
}: Args) {
  const activeRunsRef = useRef(activeRuns);
  useEffect(() => {
    activeRunsRef.current = activeRuns;
  }, [activeRuns]);

  // Starts still pending, by workflow id (plus EDITOR_KEY). The "already
  // active?" check above can't catch a double-click: `activeRuns` stays empty
  // until the first POST resolves or the WS `started` event lands, so the second
  // click would also POST, get the 409, read it as "busy behind another run"
  // and enqueue the same workflow — a second full run once the first finished.
  // The ref is the guard (synchronous, so both clicks of one double-click see
  // it); the state mirror only drives the disabled buttons.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());

  const claim = useCallback((keys: string[]): boolean => {
    if (keys.some((k) => inFlightRef.current.has(k))) return false;
    for (const k of keys) inFlightRef.current.add(k);
    setStarting(new Set(inFlightRef.current));
    return true;
  }, []);

  const release = useCallback((keys: string[]) => {
    for (const k of keys) inFlightRef.current.delete(k);
    setStarting(new Set(inFlightRef.current));
  }, []);

  const queuedBehindActive = useCallback((queued: boolean, knownActive: string | null) => {
    if (!queued) return;
    startQueuedWorkflows();
    const name = knownActive ?? activeWorkflowName(activeRunsRef.current);
    notify(name ? `Queued behind "${name}"` : 'Queued behind the active workflow');
  }, [notify, startQueuedWorkflows]);

  const runWorkflowOrQueue = useCallback(async (workflowId: string) => {
    const keys = [workflowId];
    if (!claim(keys)) return;
    try {
      const active = activeWorkflowName(activeRunsRef.current);
      if (active !== null) {
        queuedBehindActive(enqueueWorkflow(workflowId), active);
        return;
      }
      const outcome = await runWorkflow(workflowId);
      if (outcome.status === 'busy') queuedBehindActive(enqueueWorkflow(workflowId), null);
    } finally {
      release(keys);
    }
  }, [claim, enqueueWorkflow, queuedBehindActive, release, runWorkflow]);

  const runEditorWorkflowOrQueue = useCallback(async () => {
    const keys = editorWorkflowId ? [EDITOR_KEY, editorWorkflowId] : [EDITOR_KEY];
    if (!claim(keys)) return;
    try {
      const active = activeWorkflowName(activeRunsRef.current);
      if (active !== null) {
        queuedBehindActive(await enqueueEditorWorkflow(), active);
        return;
      }
      const result = await runEditorWorkflow();
      if (result?.outcome.status === 'busy') {
        // By workflow object, not id: a never-saved draft was created by this
        // very click and may not be in the saved-workflow map yet.
        queuedBehindActive(enqueueWorkflowDefinition(result.workflow), null);
      }
    } finally {
      release(keys);
    }
  }, [
    claim,
    editorWorkflowId,
    enqueueEditorWorkflow,
    enqueueWorkflowDefinition,
    queuedBehindActive,
    release,
    runEditorWorkflow,
  ]);

  return {
    runWorkflowOrQueue,
    runEditorWorkflowOrQueue,
    // Workflow ids whose ▶ Run start is pending (saved-list rows).
    startingWorkflowIds: starting,
    // The editor's ▶ Run start is pending.
    editorStarting: starting.has(EDITOR_KEY),
  };
}
