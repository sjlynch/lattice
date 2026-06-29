import { ErrorToast } from '../shared/ErrorToast';
import { LANE_BY_ID, LANES } from './lanes';
import { NewTaskOverlay } from './NewTaskOverlay';
import { PostMergeHookRow } from './PostMergeHookRow';
import { TaskBoardFilters } from './TaskBoardFilters';
import { TaskBoardFooter } from './TaskBoardFooter';
import { TaskBoardLaneGrid } from './TaskBoardLaneGrid';
import { TaskBoardSearchEmpty } from './TaskBoardSearchEmpty';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import type { useTaskBoardController } from './hooks/useTaskBoardController';

type TaskBoardController = ReturnType<typeof useTaskBoardController>;

type Props = {
  board: TaskBoardController;
};

// Panel body for the task board. TaskBoardLauncher owns only the FAB and
// FloatingPanel chrome; this component fans the controller's stable public
// surface into the existing filters, lanes, overlays, post-merge row, and
// footer without changing any child props.
export function TaskBoardPanelBody({ board }: Props) {
  return (
    <>
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
    </>
  );
}
