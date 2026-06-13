import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import {
  subscribeAgentSessions,
  subscribeTasks,
  type AgentSession,
  type Task,
} from '../../../api';
import { CLAUDE_ORANGE, taskColor } from '../../../taskColors';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { AgentOverlay, type AgentDescriptor } from '../agentOverlay';

// Drives the agent overlay from two sources, unified by the overlay's string
// agent id:
//   - in-progress *Claude* tasks → a task-colored node (id = taskId).
//   - Claude sessions OUTSIDE a worktree (push / workflow step / post-merge
//     hook) → an orange node (id = agentId), from the `/ws/agent-sessions`
//     presence snapshot.
// Focus beams for both arrive as `task-activity` (taskId) / `agent-activity`
// (agentId) events on `/ws/tasks` and just attach to the matching node.
//
// Task agents are scoped to `harness === 'claude'`; Codex/Pi have no activity
// hooks yet (documented follow-up). Non-worktree sessions are Claude-spawned
// by definition here.
function taskDescriptors(tasks: Task[]): AgentDescriptor[] {
  return tasks
    .filter((t) => t.status === 'in_progress' && t.harness === 'claude')
    .map((t) => ({ taskId: t.id, color: taskColor(t) }));
}

function sessionDescriptors(sessions: AgentSession[]): AgentDescriptor[] {
  return sessions.map((s) => ({ taskId: s.agentId, color: CLAUDE_ORANGE }));
}

export function useAgentOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  activeFolder: string,
) {
  const overlayRef = useRef<AgentOverlay | null>(null);
  // The two descriptor sources, merged on every change.
  const taskDescRef = useRef<AgentDescriptor[]>([]);
  const sessionDescRef = useRef<AgentDescriptor[]>([]);
  const rafRef = useRef(0);
  const idleHeldRef = useRef(false);

  const stopLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (idleHeldRef.current) {
      getIdleController(graphRef.current)?.releaseAgents();
      idleHeldRef.current = false;
    }
  }, [graphRef]);

  const loop = useCallback(() => {
    const overlay = overlayRef.current;
    const graph = graphRef.current;
    if (overlay && graph) {
      overlay.setSizes(
        settingsRef.current.fileNodeSize,
        settingsRef.current.labelSize,
      );
      overlay.tick(performance.now(), graph);
      if (overlay.isActive()) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
    }
    stopLoop();
  }, [graphRef, settingsRef, stopLoop]);

  const kick = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || !overlay.isActive()) return;
    if (rafRef.current) return;
    if (!idleHeldRef.current) {
      getIdleController(graphRef.current)?.acquireAgents();
      idleHeldRef.current = true;
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [graphRef, loop]);

  const applyMerged = useCallback(() => {
    const overlay = overlayRef.current;
    const graph = graphRef.current;
    if (!overlay || !graph) return;
    overlay.setAgents([...taskDescRef.current, ...sessionDescRef.current], graph);
    kick();
  }, [graphRef, kick]);

  // Create the overlay once the graph instance exists.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const overlay = new AgentOverlay(graph, settingsRef.current.fileNodeSize);
    overlayRef.current = overlay;
    applyMerged(); // apply anything that arrived before the overlay existed
    return () => {
      stopLoop();
      overlay.destroy(graph);
      overlayRef.current = null;
    };
  }, [graphRef, settingsRef, applyMerged, stopLoop]);

  // Task agents + both activity beam sources (all on `/ws/tasks`).
  useEffect(() => {
    if (!activeFolder) return;
    const unsub = subscribeTasks(
      activeFolder,
      (tasks) => {
        taskDescRef.current = taskDescriptors(tasks);
        applyMerged();
      },
      undefined,
      (event) => {
        overlayRef.current?.addActivity(
          event.taskId,
          event.file,
          event.phase,
          performance.now(),
        );
        kick();
      },
      (event) => {
        overlayRef.current?.addActivity(
          event.agentId,
          event.file,
          event.phase,
          performance.now(),
        );
        kick();
      },
    );
    return () => {
      unsub();
      taskDescRef.current = [];
      applyMerged();
    };
  }, [activeFolder, applyMerged, kick]);

  // Non-worktree Claude session presence (`/ws/agent-sessions`).
  useEffect(() => {
    if (!activeFolder) return;
    const unsub = subscribeAgentSessions(activeFolder, (sessions) => {
      sessionDescRef.current = sessionDescriptors(sessions);
      applyMerged();
    });
    return () => {
      unsub();
      sessionDescRef.current = [];
      applyMerged();
    };
  }, [activeFolder, applyMerged]);
}
