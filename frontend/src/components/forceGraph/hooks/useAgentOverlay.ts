import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { subscribeAgentSessions, subscribeTasks } from '../../../api';
import type { GraphSettings } from '../graphSettings';
import { getIdleController } from '../idleController';
import { onFrame } from '../sceneFrameDriver';
import { AgentOverlay, type AgentDescriptor } from '../agentOverlay';
import { PendingActivityBuffer } from '../agentActivityBuffer';
import {
  reapStaleSatellites,
  routeAgentActivity,
  sameDescriptors,
  sessionDescriptors,
  taskDescriptors,
  type ActivityLike,
} from './agentOverlayEvents';

// How often a settled scene is checked for a satellite past its idle TTL.
const SATELLITE_REAP_CHECK_MS = 30_000;

// Hook half of the **Agent Presence Layer (APL)** — the scene overlay that
// shows where live agents (Claude, Codex, Pi) are working (a hovering
// "presence node" per agent + TTL "focus beams" to the files it touches). This hook owns the APL's
// lifecycle and its render-on-demand contract with the idle controller; the
// drawing lives in `agentOverlay.ts` (+ its `agentOverlay*` siblings).
//
// Render-on-demand: the APL is driven off the graph's real render frames
// (`scene.onBeforeRender`) and holds the idle controller's `agents` reason ONLY
// while `overlay.tick` reports self-driven motion, releasing it the frame the
// agents settle. An idle-but-in-progress agent therefore lets the render loop
// suspend. (Regression history: it used to hold `agents` for the whole lifetime
// of any agent, pinning the loop at 60fps — see forceGraph/CLAUDE.md.)
//
// Drives the overlay from two sources, unified by the overlay's string
// agent id:
//   - in-progress tasks → a task-colored node (id = taskId).
//   - agent sessions OUTSIDE a worktree (push / workflow step / post-merge
//     hook) → an orange node (id = agentId), from the `/ws/agent-sessions`
//     presence snapshot. An agent in a terminal the user opened is one of
//     these too: orange for Claude, white for Codex, blue for Pi (see
//     sessionColor). The backend shows such a node only while the agent is
//     mid-turn (backend projectClaude/lifecycle.ts).
// Focus beams for both arrive as `task-activity` (taskId) / `agent-activity`
// (agentId) events on `/ws/tasks` and just attach to the matching node.
export function useAgentOverlay(
  graphRef: MutableRefObject<ForceGraph3DInstance | null>,
  settingsRef: MutableRefObject<GraphSettings>,
  activeFolder: string,
) {
  const overlayRef = useRef<AgentOverlay | null>(null);
  // The two descriptor sources, merged on every change.
  const taskDescRef = useRef<AgentDescriptor[]>([]);
  const sessionDescRef = useRef<AgentDescriptor[]>([]);
  // Whether we currently hold the idle controller's `agents` reason (a boolean
  // hold, not a counter): acquired to wake the render loop, released the frame
  // the overlay settles. Kept in sync by `kick` (acquire) and the frame handler
  // (release on rest), so it can never leak a permanent hold.
  const idleHeldRef = useRef(false);
  // Activity frames for agents whose node hasn't appeared yet.
  const pendingRef = useRef(new PendingActivityBuffer<ActivityLike>());

  // Wake the render loop so a pending change paints: a new/removed agent, a new
  // beam, or ongoing easing. The per-frame handler below releases the hold again
  // once `overlay.tick` reports the overlay has settled, so this never pins the
  // loop the way the old "hold while any agent exists" logic did.
  const kick = useCallback(() => {
    if (idleHeldRef.current) return;
    // Set the hold flag BEFORE acquiring. `acquireAgents` → `sync` →
    // `resumeAnimation` renders synchronously, which re-enters this overlay's
    // frame callback (and thus `kick`/`release`) before control returns here.
    // Flipping the flag first makes that re-entrant call bail at its guard,
    // preventing unbounded recursion (and a leaked `agents` count).
    idleHeldRef.current = true;
    getIdleController(graphRef.current)?.acquireAgents();
  }, [graphRef]);

  // Wake the render loop to paint a one-shot set change (a satellite removed)
  // that has no follow-on motion of its own — same guaranteed short frame tail
  // `applyMerged` uses for an agent add/remove.
  const wakeRefresh = useCallback(() => {
    getIdleController(graphRef.current)?.wakeForRefresh();
  }, [graphRef]);

  // Read the live overlay and clock before handing the frame to the event router.
  const routeActivity = useCallback(
    (parentId: string, event: ActivityLike) => {
      const ov = overlayRef.current;
      if (!ov) return;
      const now = performance.now();
      routeAgentActivity(
        ov,
        pendingRef.current,
        parentId,
        event,
        now,
        kick,
        wakeRefresh,
      );
    },
    [kick, wakeRefresh],
  );

  const applyMerged = useCallback(() => {
    const overlay = overlayRef.current;
    const graph = graphRef.current;
    if (!overlay || !graph) return;
    const changed = overlay.setAgents(
      [...taskDescRef.current, ...sessionDescRef.current],
      graph,
    );
    // Replay activity that arrived before its agent's node existed.
    const pending = pendingRef.current;
    const now = performance.now();
    for (const id of pending.agentIds()) {
      if (!overlay.hasAgent(id)) continue;
      for (const event of pending.take(id, now)) routeActivity(id, event);
    }
    kick();
    // A removal (agent stopped) takes effect by deleting the node/label from the
    // scene — but the render loop may be idle, so nothing would repaint it away.
    // `kick`'s motion-gated `agents` reason settles after a single frame; a SET
    // change instead gets the same guaranteed short frame tail every other
    // one-shot scene mutator uses (selection halo, worktree ring, labels), so a
    // stopped agent's node reliably disappears even from a fully settled scene.
    if (changed) getIdleController(graph)?.wakeForRefresh();
  }, [graphRef, kick, routeActivity]);

  // Create the overlay once the graph instance exists, and drive its per-frame
  // tick from the graph's OWN render frames via the shared scene frame driver
  // (scene.onBeforeRender, fired by THREE at the head of every render). This
  // means:
  //   - the overlay updates exactly when the scene actually paints — for free
  //     while the loop is already running for another reason (engine hot, user
  //     interacting), so beams track moving file nodes without us forcing frames;
  //   - we hold the idle controller's `agents` reason ONLY while `tick` reports
  //     self-driven motion (easing / fading), and drop it the moment it settles.
  // That's the render-on-demand fix: an idle-but-in-progress agent no longer
  // keeps the render loop spinning.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const overlay = new AgentOverlay(graph, settingsRef.current.fileNodeSize);
    overlayRef.current = overlay;
    const idle = getIdleController(graph);

    const release = () => {
      if (!idleHeldRef.current) return;
      // Clear the hold flag BEFORE releasing. `releaseAgents` → `sync` →
      // `resumeAnimation` can render synchronously (when another reason still
      // wants the loop), re-entering this frame callback before control
      // returns. Clearing first makes the re-entrant `release` bail at the
      // guard above instead of recursing into `releaseAgents` forever.
      idleHeldRef.current = false;
      idle?.releaseAgents();
    };

    const offFrame = onFrame(graph, (now) => {
      // Cheap early-out: with nothing on screen and no hold, skip all per-frame
      // work so ordinary (agent-free) renders pay nothing.
      if (!overlay.isActive() && !idleHeldRef.current) return;
      overlay.setSizes(
        settingsRef.current.fileNodeSize,
        settingsRef.current.labelSize,
        settingsRef.current.showSubagentLabels,
      );
      // While the layout is live, file nodes move under the beams, so the graph
      // bounds (hover-line height) must be recomputed; once settled they're
      // cached. See AgentPathIndex.bounds / idleController.isEngineHot.
      if (overlay.tick(now, graph, idle?.isEngineHot() ?? false)) kick();
      else release();
    });

    // A satellite whose SubagentStop was missed is reaped inside `tick`, which
    // only runs while the loop renders — on a settled, paused scene (or a
    // hidden tab / 0×0 graph, where the loop can't render at all) the dead
    // satellite and its beams stayed alive until something else woke the
    // graph. Reap on a slow timer instead, waking the loop only when one went.
    const reapTimer = setInterval(() => {
      reapStaleSatellites(overlay, performance.now(), kick, wakeRefresh);
    }, SATELLITE_REAP_CHECK_MS);

    applyMerged(); // apply anything that arrived before the overlay existed
    return () => {
      clearInterval(reapTimer);
      release();
      offFrame();
      overlay.destroy(graph);
      overlayRef.current = null;
    };
  }, [graphRef, settingsRef, applyMerged, kick, wakeRefresh]);

  // Task agents + both activity beam sources (all on `/ws/tasks`).
  useEffect(() => {
    if (!activeFolder) return;
    const unsub = subscribeTasks(
      activeFolder,
      (tasks) => {
        const next = taskDescriptors(tasks);
        if (sameDescriptors(next, taskDescRef.current)) return;
        taskDescRef.current = next;
        applyMerged();
      },
      undefined,
      (event) => routeActivity(event.taskId, event),
      (event) => routeActivity(event.agentId, event),
    );
    return () => {
      unsub();
      taskDescRef.current = [];
      pendingRef.current.clear();
      applyMerged();
    };
  }, [activeFolder, applyMerged, routeActivity]);

  // Non-worktree agent session presence (`/ws/agent-sessions`).
  useEffect(() => {
    if (!activeFolder) return;
    const unsub = subscribeAgentSessions(activeFolder, (sessions) => {
      const next = sessionDescriptors(sessions);
      if (sameDescriptors(next, sessionDescRef.current)) return;
      sessionDescRef.current = next;
      applyMerged();
    });
    return () => {
      unsub();
      sessionDescRef.current = [];
      applyMerged();
    };
  }, [activeFolder, applyMerged]);
}
