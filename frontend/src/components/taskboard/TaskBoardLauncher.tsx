import { useState } from 'react';
import { Kanban } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { ErrorToast } from '../shared/ErrorToast';
import { LANE_BY_ID, LANES } from './lanes';
import { NewTaskOverlay } from './NewTaskOverlay';
import { PostMergeHookRow } from './PostMergeHookRow';
import { TaskBoardFilters } from './TaskBoardFilters';
import { TaskBoardFooter } from './TaskBoardFooter';
import { TaskBoardLaneGrid } from './TaskBoardLaneGrid';
import { TaskBoardSearchEmpty } from './TaskBoardSearchEmpty';
import { TaskBoardTitle } from './TaskBoardTitle';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { useTaskBoardController } from './hooks/useTaskBoardController';

type Props = {
  activeFolder: string;
};

// Top-level Task Board: opens the floating panel and renders the lanes. The
// controller hook owns task/terminal/merge/QA wiring so this component stays a
// FloatingPanel/chrome shell plus the JSX placement of overlays and rows.
export function TaskBoardLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const board = useTaskBoardController(activeFolder);

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
        {board.activeCount > 0 && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginLeft: 2,
            }}
          >
            · {board.activeCount}
          </span>
        )}
      </button>

      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        title={
          <TaskBoardTitle
            taskSearch={board.taskSearch}
            setTaskSearch={board.setTaskSearch}
          />
        }
        defaultSize={{ width: 720, height: 620 }}
        minSize={{ width: 460, height: 380 }}
        storageKey="lattice.taskboard.window"
      >
        <TaskBoardFilters
          lanes={LANES}
          visibleLanes={board.visibleLanes}
          grouped={board.filteredGrouped}
          harness={board.harness}
          piModel={board.piModel}
          piMenu={board.piMenu}
          selectHarness={board.selectHarness}
          harnessAvail={board.harnessAvail}
          onToggleLane={board.toggleLane}
        />
        <div className="taskboard-body">
          <div className="taskboard-scroll">
            {board.searchActive && board.filteredTasks.length === 0 ? (
              <TaskBoardSearchEmpty
                query={board.taskSearch.trim()}
                onClear={() => board.setTaskSearch('')}
              />
            ) : (
              <TaskBoardLaneGrid
                visibleLanes={board.visibleLanes}
                sortedGrouped={board.sortedGrouped}
                qaTasks={board.filteredGrouped.qa}
                tasks={board.tasks}
                draggingId={board.draggingId}
                selectedIds={board.selectedIds}
                onDragStart={board.setDraggingId}
                onDragEnd={board.handleDragEnd}
                onToggleSelect={board.toggleSelect}
                onRangeSelect={board.rangeSelect}
                onClearSelection={board.clearSelection}
                onAdd={board.setAddingTo}
                onMove={board.moveTask}
                onDropAt={board.handleDropAt}
                onMultiMove={board.moveMulti}
                onMultiDropAt={board.handleMultiDropAt}
                onDelete={board.deleteTask}
                onRun={board.runTask}
                onCancelQueuedRun={board.cancelQueuedRun}
                onResume={board.resumeTaskAction}
                onMerge={board.mergeTaskAction}
                onView={board.setViewing}
                getFocusTerminal={board.getFocusTerminal}
                getLaneSortMode={board.getLaneSortMode}
                onToggleSort={board.toggleLaneSort}
                searchActive={board.searchActive}
                runAllActionByLane={board.runAllActionByLane}
                hasGit={board.hasGit}
                onPush={board.startPush}
                pushDisabled={!!board.activePush}
                qaPlaywright={board.qaPlaywright}
                onQaRun={board.startQaRun}
                onQaRunAll={board.startAllQaRuns}
                mergeRun={board.mergeRun}
                recentRunSummary={board.recentRunSummary}
                onCancelActiveRun={board.cancelActiveRun}
                onClearStuckConflicts={board.clearStuckConflicts}
                onDismissRecent={board.dismissRecent}
                bulkStrips={board.bulkStrips}
                onDismissBulk={board.dismissBulk}
              />
            )}
          </div>
          <PostMergeHookRow
            prompt={board.postMergeHook.form.prompt}
            enabled={board.postMergeHook.form.enabled}
            harness={board.postMergeHook.form.harness}
            piModel={board.postMergeHook.form.piModel}
            piMenu={board.piMenu}
            harnessAvail={board.harnessAvail}
            active={board.postMergeHook.active}
            recent={board.postMergeHook.recent}
            saving={board.postMergeHook.saving}
            onSavePrompt={board.postMergeHook.savePrompt}
            onToggleEnabled={board.postMergeHook.saveEnabled}
            onSaveHarness={board.postMergeHook.saveHarness}
            onAbort={board.postMergeHook.abort}
            onFocusActiveTerminal={board.focusPostMergeTerminal}
          />
          {board.addingTo && (
            <NewTaskOverlay
              lane={LANE_BY_ID[board.addingTo]}
              onCancel={() => board.setAddingTo(null)}
              onSubmit={board.submitNewTask}
            />
          )}
          {board.viewing && (
            <TaskDetailOverlay
              task={board.viewing}
              onClose={() => board.setViewing(null)}
              onMove={board.moveViewingTask}
              onDelete={board.deleteViewingTask}
              onSave={board.saveViewingTask}
              onRun={board.runViewingTask}
            />
          )}
          {board.error && (
            <ErrorToast
              message={board.error}
              onDismiss={() => board.setError(null)}
            />
          )}
        </div>
        <TaskBoardFooter
          tasks={board.tasks}
          filteredTasks={board.filteredTasks}
          searchActive={board.searchActive}
        />
      </FloatingPanel>
    </>
  );
}
