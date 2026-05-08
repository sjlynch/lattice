import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kanban } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { useTerminals } from '../../TerminalsContext';
import {
  cancelMergeRun as apiCancelMergeRun,
  createTask as apiCreateTask,
  deleteTask as apiDeleteTask,
  fetchHarnessAvailability,
  fetchTasks,
  fetchUserSettings,
  getActiveMergeRun,
  mergeTask as apiMergeTask,
  patchUserSettings,
  reorderTasks as apiReorderTasks,
  resumeTask as apiResumeTask,
  runTask as apiRunTask,
  startMergeRun as apiStartMergeRun,
  subscribeMergeRuns,
  subscribeTasks,
  updateTask as apiUpdateTask,
  type HarnessAvailability,
  type MergeRun,
  type Task,
  type TaskStatus,
} from '../../api';
import { ErrorToast } from '../shared/ErrorToast';
import { LANE_BY_ID, LANES, shortLabel } from './lanes';
import { Lane } from './Lane';
import { MergeRunStrip } from './MergeRunStrip';
import { NewTaskOverlay } from './NewTaskOverlay';
import { TaskDetailOverlay } from './TaskDetailOverlay';

type Props = {
  activeFolder: string;
};

// Top-level Task Board: opens the floating panel, owns task/run state
// hydration + WebSocket subscriptions, and routes per-action calls
// (run/resume/merge/etc.) to the API + spawns the right terminal.
export function TaskBoardLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<TaskStatus | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [selectionLane, setSelectionLane] = useState<TaskStatus | null>(null);
  const [mergeRun, setMergeRun] = useState<MergeRun | null>(null);
  const [recentRunSummary, setRecentRunSummary] = useState<MergeRun | null>(
    null,
  );
  const [harness, setHarness] = useState<'claude' | 'pi' | 'codex' | 'interleave'>('claude');
  const interleaveNextRef = useRef<'claude' | 'pi'>('claude');
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });

  // Filter state — all lanes visible by default.
  const [visibleLanes, setVisibleLanes] = useState<Set<TaskStatus>>(
    () => new Set(LANES.map((l) => l.id)),
  );

  const { addTerminal, closeTerminalsForTask, terminals, setActiveId } =
    useTerminals();

  // Build a taskId → most-recent-terminal-id map for the focus button.
  // A merge resolver and a worktree Claude can both exist for the same
  // task; the merge one is more interesting to focus on, so prefer 'merge'
  // kind, otherwise fall back to the most recently added terminal.
  const terminalByTaskId = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of terminals) {
      if (!t.taskId) continue;
      const existing = m.get(t.taskId);
      if (!existing) {
        m.set(t.taskId, t.id);
        continue;
      }
      if (t.kind === 'merge') m.set(t.taskId, t.id);
    }
    return m;
  }, [terminals]);

  const getFocusTerminal = useCallback(
    (task: Task): (() => void) | null => {
      const termId = terminalByTaskId.get(task.id);
      if (!termId) return null;
      return () => setActiveId(termId);
    },
    [terminalByTaskId, setActiveId],
  );

  // Auto-close terminals when their task reaches a terminal state. Runs on
  // every task update so it also catches stale sessionStorage terminals that
  // survive a server restart.
  useEffect(() => {
    for (const task of tasks) {
      if (
        task.status === 'qa' ||
        task.status === 'done' ||
        task.status === 'deleted'
      ) {
        closeTerminalsForTask(task.id);
      }
    }
  }, [tasks, closeTerminalsForTask]);

  // Initial load + WS subscription per active folder.
  useEffect(() => {
    if (!activeFolder) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    fetchTasks(activeFolder)
      .then((ts) => {
        if (!cancelled) setTasks(ts);
      })
      .catch((err) => console.error('fetchTasks', err));
    const unsub = subscribeTasks(activeFolder, (ts) => {
      if (!cancelled) setTasks(ts);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder]);

  // Detect once which agent CLIs are installed. Drives whether the Pi /
  // Interleave options appear in the harness selector.
  useEffect(() => {
    let cancelled = false;
    fetchHarnessAvailability().then((avail) => {
      if (!cancelled) setHarnessAvail(avail);
    });
    return () => { cancelled = true; };
  }, []);

  // Load persisted harness preference when the active folder changes.
  // If the saved harness CLI isn't installed, coerce back to `claude` so we
  // never try to spawn an unavailable harness.
  useEffect(() => {
    if (!activeFolder) return;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (!s.harness) return;
        const unavailable =
          ((s.harness === 'pi' || s.harness === 'interleave') && !harnessAvail.pi) ||
          (s.harness === 'codex' && !harnessAvail.codex);
        if (unavailable) {
          setHarness('claude');
          patchUserSettings(activeFolder, { harness: 'claude' }).catch(() => {});
        } else {
          setHarness(s.harness);
        }
      })
      .catch(() => { /* keep default */ });
  }, [activeFolder, harnessAvail.pi, harnessAvail.codex]);

  // Hydrate the active merge run on mount and subscribe to live events.
  // Closing the panel/tab doesn't cancel the run — it keeps progressing on
  // the backend. On reopen we resync via /api/merge-runs/active.
  useEffect(() => {
    // Reset run state on every folder switch so a summary from project A
    // doesn't briefly flash when the user opens project B.
    setMergeRun(null);
    setRecentRunSummary(null);
    if (!activeFolder) return;
    let cancelled = false;
    getActiveMergeRun(activeFolder)
      .then((r) => {
        if (!cancelled) setMergeRun(r);
      })
      .catch(() => {
        /* ignore */
      });
    const unsub = subscribeMergeRuns(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type === 'idle') {
        // Server confirmed no active run — clear any stale state left over
        // from a run that completed while the WS was disconnected.
        setMergeRun(null);
      } else if (ev.type === 'started' || ev.type === 'progress') {
        setMergeRun(ev.run);
      } else if (ev.type === 'completed' || ev.type === 'cancelled') {
        setMergeRun(null);
        setRecentRunSummary(ev.run);
        // Auto-clear summary after a few seconds.
        setTimeout(() => {
          setRecentRunSummary((cur) => (cur?.id === ev.run.id ? null : cur));
        }, 8000);
      } else if (ev.type === 'conflict') {
        // Spawn the resolver Claude in the worktree. Same flow the per-card
        // merge button uses; the run worker doesn't have UI access so the
        // frontend handles the terminal half. Backend pre-spawns the pty
        // and ships the serverId in the event so the pane can lazy-mount.
        addTerminal({
          label: `merge:${ev.taskId.slice(-6)}`,
          cwd: ev.cwd,
          initialCommand: ev.command,
          taskId: ev.taskId,
          kind: 'merge',
          projectPath: activeFolder,
          serverId: ev.serverId,
        }, false);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder, addTerminal]);

  // Keep "viewing" task fresh when underlying list updates.
  useEffect(() => {
    if (!viewing) return;
    const fresh = tasks.find((t) => t.id === viewing.id);
    if (!fresh) {
      setViewing(null);
      return;
    }
    if (fresh !== viewing) setViewing(fresh);
  }, [tasks, viewing]);

  function showError(msg: string) {
    setError(msg);
    setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 5000);
  }

  async function addTask(status: TaskStatus, title: string, description?: string) {
    if (!activeFolder || !title.trim()) return;
    try {
      const created = await apiCreateTask(activeFolder, title, description);
      // If we're adding to a non-open lane, immediately update its status.
      if (status !== 'open') {
        await apiUpdateTask(created.id, { status });
      }
    } catch (err) {
      showError((err as Error).message);
    }
  }

  async function moveTask(id: string, status: TaskStatus) {
    try {
      await apiUpdateTask(id, { status });
    } catch (err) {
      showError((err as Error).message);
    }
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setAnchorId(null);
    setSelectionLane(null);
  }

  function handleToggleSelect(id: string, laneId: TaskStatus) {
    if (selectionLane !== null && selectionLane !== laneId) {
      setSelectedIds(new Set([id]));
      setSelectionLane(laneId);
      setAnchorId(id);
      return;
    }
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setSelectionLane(next.size > 0 ? laneId : null);
    setAnchorId(id);
  }

  function handleSingleSelect(id: string, laneId: TaskStatus) {
    if (selectedIds.size === 1 && selectedIds.has(id)) {
      clearSelection();
      return;
    }
    setSelectedIds(new Set([id]));
    setSelectionLane(laneId);
    setAnchorId(id);
  }

  function handleRangeSelect(id: string, laneId: TaskStatus) {
    const anchor = anchorId ? tasks.find((t) => t.id === anchorId) : null;
    if (!anchor || anchor.status !== laneId) {
      setSelectedIds(new Set([id]));
      setSelectionLane(laneId);
      setAnchorId(id);
      return;
    }
    const laneTasks = grouped[laneId];
    const anchorIdx = laneTasks.findIndex((t) => t.id === anchorId);
    const targetIdx = laneTasks.findIndex((t) => t.id === id);
    if (anchorIdx === -1 || targetIdx === -1) {
      setSelectedIds(new Set([id]));
      setSelectionLane(laneId);
      return;
    }
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    setSelectedIds(new Set(laneTasks.slice(lo, hi + 1).map((t) => t.id)));
    setSelectionLane(laneId);
  }

  // Move multiple tasks to a lane without a specific slot index (append).
  async function moveMulti(ids: string[], targetStatus: TaskStatus) {
    if (!activeFolder) return;
    const srcTasks = ids
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t)
      .sort((a, b) => (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt));
    if (!srcTasks.length) return;
    const newLane = grouped[targetStatus].filter((t) => !ids.includes(t.id));
    newLane.push(...srcTasks);
    try {
      await apiReorderTasks(activeFolder, targetStatus, newLane.map((t) => t.id));
      clearSelection();
    } catch (err) {
      showError((err as Error).message);
    }
  }

  // Drop multiple tasks at a specific position in the target lane.
  async function dropAtMulti(
    ids: string[],
    targetStatus: TaskStatus,
    targetIndex: number,
  ) {
    if (!activeFolder) return;
    const srcTasks = ids
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is Task => !!t)
      .sort((a, b) => (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt));
    if (!srcTasks.length) return;
    const targetLane = grouped[targetStatus].slice();
    const remaining = targetLane.filter((t) => !ids.includes(t.id));
    let insertAt = targetIndex;
    for (let i = 0; i < targetIndex && i < targetLane.length; i++) {
      if (ids.includes(targetLane[i].id)) insertAt--;
    }
    insertAt = Math.max(0, Math.min(insertAt, remaining.length));
    remaining.splice(insertAt, 0, ...srcTasks);
    try {
      await apiReorderTasks(activeFolder, targetStatus, remaining.map((t) => t.id));
      clearSelection();
    } catch (err) {
      showError((err as Error).message);
    }
  }

  // Drop handler used by lane drop slots. `targetIndex` is the position in
  // the destination lane's visible order where the task should land. Computes
  // the new ID order for the lane and ships it as a single batched reorder.
  async function dropAt(
    id: string,
    targetStatus: TaskStatus,
    targetIndex: number,
  ) {
    if (!activeFolder) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const lane = grouped[targetStatus].slice();
    const fromIdx = lane.findIndex((t) => t.id === id);
    let insertAt = targetIndex;
    if (fromIdx !== -1) {
      lane.splice(fromIdx, 1);
      if (fromIdx < insertAt) insertAt -= 1;
    }
    insertAt = Math.max(0, Math.min(insertAt, lane.length));
    if (fromIdx === insertAt && task.status === targetStatus) return;
    lane.splice(insertAt, 0, task);
    try {
      await apiReorderTasks(activeFolder, targetStatus, lane.map((t) => t.id));
    } catch (err) {
      showError((err as Error).message);
    }
  }

  async function editTask(
    id: string,
    updates: { title?: string; description?: string },
  ) {
    try {
      await apiUpdateTask(id, updates);
    } catch (err) {
      showError((err as Error).message);
    }
  }

  async function deleteTask(id: string) {
    try {
      await apiDeleteTask(id);
    } catch (err) {
      showError((err as Error).message);
    }
  }

  // Resolve the harness to spawn for this run. In `interleave` mode we
  // alternate claude/pi across consecutive runs so a "Run All" produces a
  // mix; in single-mode the user's choice is used directly.
  function resolveHarness(): 'claude' | 'pi' | 'codex' {
    if (harness !== 'interleave') return harness;
    const pick = interleaveNextRef.current;
    interleaveNextRef.current = pick === 'claude' ? 'pi' : 'claude';
    return pick;
  }

  async function runTask(task: Task) {
    try {
      const res = await apiRunTask(task.id, resolveHarness());
      addTerminal({
        label: shortLabel(task.title),
        cwd: res.worktreePath,
        initialCommand: res.command,
        taskId: task.id,
        projectPath: task.projectPath,
        serverId: res.serverId,
      }, false);
    } catch (err) {
      showError(`Run failed: ${(err as Error).message}`);
    }
  }

  async function runAllOpen() {
    const openTasks = tasks
      .filter((t) => t.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of openTasks) {
      // sequentially to avoid hammering git
      // eslint-disable-next-line no-await-in-loop
      await runTask(t);
    }
  }

  async function resumeTaskAction(task: Task) {
    try {
      const res = await apiResumeTask(task.id, resolveHarness());
      addTerminal({
        label: shortLabel(task.title),
        cwd: res.worktreePath,
        initialCommand: res.command,
        taskId: task.id,
        projectPath: task.projectPath,
        serverId: res.serverId,
      }, false);
    } catch (err) {
      showError(`Resume failed: ${(err as Error).message}`);
    }
  }

  async function resumeAllInProgress() {
    const list = tasks
      .filter((t) => t.status === 'in_progress' && !!t.worktreePath)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of list) {
      // eslint-disable-next-line no-await-in-loop
      await resumeTaskAction(t);
    }
  }

  async function mergeTaskAction(task: Task): Promise<boolean> {
    try {
      const res = await apiMergeTask(task.id);
      if (res.merged) return true;
      // Either a worktree merge conflict or a stash-pop conflict in main —
      // both are handled by spawning a resolver Claude as a merge terminal.
      addTerminal({
        label: `merge:${shortLabel(task.title)}`,
        cwd: res.cwd,
        initialCommand: res.command,
        taskId: task.id,
        kind: 'merge',
        projectPath: task.projectPath,
        serverId: res.serverId,
      }, false);
      return false;
    } catch (err) {
      showError(`Merge failed: ${(err as Error).message}`);
      return false;
    }
  }

  async function mergeAllReady() {
    if (!activeFolder) return;
    try {
      await apiStartMergeRun(activeFolder);
      // Run is now backend-driven; UI subscribes to /ws/merge-runs for
      // progress and conflict events. Closing the panel/tab won't stop it.
    } catch (err) {
      showError(`Merge all failed to start: ${(err as Error).message}`);
    }
  }

  async function cancelActiveRun() {
    if (!mergeRun) return;
    try {
      await apiCancelMergeRun(mergeRun.id);
    } catch (err) {
      showError(`Cancel failed: ${(err as Error).message}`);
    }
  }

  async function markAllQaDone() {
    const qaTasks = tasks.filter((t) => t.status === 'qa');
    await Promise.all(qaTasks.map((t) => moveTask(t.id, 'done')));
  }

  // Group + sort tasks per lane. Tasks with an explicit sortOrder use it
  // directly; tasks without one fall back to `-createdAt` so newly-created
  // tasks land at the top of the lane (matches the prior newest-first
  // behavior).
  const grouped = useMemo(() => {
    const m: Record<TaskStatus, Task[]> = {
      backlog: [],
      open: [],
      in_progress: [],
      ready_to_merge: [],
      qa: [],
      done: [],
      deleted: [],
    };
    for (const t of tasks) m[t.status].push(t);
    for (const k of Object.keys(m) as TaskStatus[]) {
      m[k].sort(
        (a, b) =>
          (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt),
      );
    }
    return m;
  }, [tasks]);

  const activeCount = tasks.filter(
    (t) =>
      t.status !== 'deleted' && t.status !== 'done' && t.status !== 'backlog',
  ).length;

  function toggleLane(id: TaskStatus) {
    setVisibleLanes((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleHarnessChange(val: 'claude' | 'pi' | 'codex' | 'interleave') {
    setHarness(val);
    interleaveNextRef.current = 'claude';
    if (activeFolder) patchUserSettings(activeFolder, { harness: val }).catch(() => {});
  }

  return (
    <>
      <button
        className="fab"
        onClick={() => setOpen(true)}
        title="Open task board"
        aria-label="Open task board"
      >
        <Kanban size={15} />
        <span>Tasks</span>
        {activeCount > 0 && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginLeft: 2,
            }}
          >
            · {activeCount}
          </span>
        )}
      </button>

      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        title={
          <>
            <Kanban size={13} />
            Task board
          </>
        }
        defaultSize={{ width: 720, height: 620 }}
        minSize={{ width: 460, height: 380 }}
        storageKey="lattice.taskboard.window"
      >
        <div className="taskboard-filters">
          {LANES.map((lane) => {
            const on = visibleLanes.has(lane.id);
            return (
              <button
                key={lane.id}
                className={`taskboard-filter ${on ? '' : 'off'}`}
                onClick={() => toggleLane(lane.id)}
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
              onChange={(e) => handleHarnessChange(e.target.value as 'claude' | 'pi' | 'codex' | 'interleave')}
              title="Agent harness for running tasks"
            >
              <option value="claude">Claude</option>
              {harnessAvail.pi && <option value="pi">Pi</option>}
              {harnessAvail.codex && <option value="codex">Codex</option>}
              {harnessAvail.pi && <option value="interleave">Interleave</option>}
            </select>
          )}
        </div>
        <div className="taskboard-body">
          <div className="taskboard-scroll">
            {LANES.filter((l) => visibleLanes.has(l.id)).map((lane) => (
              <Lane
                key={lane.id}
                lane={lane}
                tasks={grouped[lane.id]}
                draggingId={draggingId}
                selectedIds={selectedIds}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
                onAdd={() => setAddingTo(lane.id)}
                onMove={moveTask}
                onDropAt={dropAt}
                onMultiMove={moveMulti}
                onMultiDropAt={dropAtMulti}
                onDelete={deleteTask}
                onRun={runTask}
                onResume={resumeTaskAction}
                onMerge={mergeTaskAction}
                getFocusTerminal={getFocusTerminal}
                onSingleSelect={(id) => handleSingleSelect(id, lane.id)}
                onToggleSelect={(id) => handleToggleSelect(id, lane.id)}
                onRangeSelect={(id) => handleRangeSelect(id, lane.id)}
                onClearSelection={clearSelection}
                onRunAll={
                  lane.id === 'open'
                    ? runAllOpen
                    : lane.id === 'in_progress'
                    ? resumeAllInProgress
                    : lane.id === 'ready_to_merge'
                    ? mergeAllReady
                    : lane.id === 'qa'
                    ? markAllQaDone
                    : undefined
                }
                onView={setViewing}
                strip={(() => {
                  if (lane.id !== 'ready_to_merge') return undefined;
                  const hasConflicts = grouped['ready_to_merge'].some((t) => t.conflict);
                  if (!mergeRun && !recentRunSummary && !hasConflicts) return undefined;
                  return (
                    <MergeRunStrip
                      active={mergeRun}
                      summary={recentRunSummary}
                      tasks={tasks}
                      onCancel={cancelActiveRun}
                      onDismiss={() => setRecentRunSummary(null)}
                    />
                  );
                })()}
              />
            ))}
          </div>
          {addingTo && (
            <NewTaskOverlay
              lane={LANE_BY_ID[addingTo]}
              onCancel={() => setAddingTo(null)}
              onSubmit={(title, desc) => {
                addTask(addingTo, title, desc);
                setAddingTo(null);
              }}
            />
          )}
          {viewing && (
            <TaskDetailOverlay
              task={viewing}
              onClose={() => setViewing(null)}
              onMove={(status) => moveTask(viewing.id, status)}
              onDelete={() => {
                deleteTask(viewing.id);
                setViewing(null);
              }}
              onSave={(updates) => editTask(viewing.id, updates)}
              onRun={
                viewing.status === 'open'
                  ? () => {
                      runTask(viewing);
                      setViewing(null);
                    }
                  : undefined
              }
            />
          )}
          {error && (
            <ErrorToast message={error} onDismiss={() => setError(null)} />
          )}
        </div>
        <div className="taskboard-footer">
          {tasks.length} total · drag to reorder · click to select · ctrl+click or shift+click to multi-select · pencil to edit
        </div>
      </FloatingPanel>
    </>
  );
}
