import { WebSocketServer } from 'ws';
import {
  getActiveRunsForProject as getActiveWorkflowRunsForProject,
  subscribe as subscribeWorkflowRuns,
} from '../../workflowRuns.js';
import type { WorkflowRun } from '../../workflowRuns/state.js';
import {
  isWorkflowRecoveryDone,
  whenWorkflowRecoveryDone,
} from '../../workflowRuns/recoveryReadiness.js';
import {
  buildProjectWss,
  projectFromRunEvent,
  type ProjectRunEvent,
} from '../projectEndpoint.js';

// The follow-up snapshot a connection gets once boot recovery has put the
// persisted runs back in the registry. Per-connection (never broadcast).
type RecoveredHelloEvent = {
  type: 'hello';
  projectPath: string;
  runs: WorkflowRun[];
};
type WorkflowRunsWsEvent = ProjectRunEvent | RecoveredHelloEvent;

function isRecoveredHello(ev: WorkflowRunsWsEvent): ev is RecoveredHelloEvent {
  return (ev as { type?: unknown }).type === 'hello';
}

// `hello` is the client's AUTHORITATIVE active-runs snapshot: the frontend
// replaces its map with it, and the workflow queue reads a run that left the
// map with no terminal event as interrupted → it stops. After a backend
// restart the runs are only back in the registry once post-listen recovery
// registers them, so a client reconnecting in that window used to get an
// EMPTY hello and stop its queue even though the run was about to reappear.
//
// So while recovery is pending the hello carries `recovering: true` (the
// client merges it additively and removes nothing), and when recovery
// finishes the connection gets a second, authoritative hello. A connection
// that raced recovery's end may get two authoritative hellos — idempotent.
export function buildWorkflowRunsWss(): WebSocketServer {
  return buildProjectWss<WorkflowRunsWsEvent>({
    initial: (project) => ({
      type: 'hello',
      runs: getActiveWorkflowRunsForProject(project),
      ...(isWorkflowRecoveryDone() ? {} : { recovering: true }),
    }),
    subscribe: (listener, project) => {
      const unsub = subscribeWorkflowRuns(listener);
      let live = true;
      if (!isWorkflowRecoveryDone()) {
        // Delivered through the listener so the connect handshake buffers it
        // behind the initial snapshot if recovery lands mid-load.
        void whenWorkflowRecoveryDone().then(() => {
          if (!live) return;
          listener({
            type: 'hello',
            projectPath: project,
            runs: getActiveWorkflowRunsForProject(project),
          });
        });
      }
      return () => {
        live = false;
        unsub();
      };
    },
    projectFromEvent: projectFromRunEvent,
    payloadFromEvent: (ev) =>
      isRecoveredHello(ev) ? { type: 'hello', runs: ev.runs } : ev,
  });
}
