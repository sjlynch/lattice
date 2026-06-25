import { Play, Plus, Square, Trash2 } from 'lucide-react';

// The action footer beneath the editor: Delete / Discard / Save (or Create) /
// Queue / Run (or Stop). The disabled buttons carry a tooltip naming their
// unblock condition so a greyed button never reads as broken.
export function WorkflowEditorActions({
  workflowId,
  dirty,
  hasSteps,
  hasActiveFolder,
  runId,
  deleting,
  onDelete,
  onDiscard,
  onSave,
  onQueue,
  onRun,
  onStop,
}: {
  workflowId: string | null;
  dirty: boolean;
  hasSteps: boolean;
  hasActiveFolder: boolean;
  runId: string | null;
  deleting: boolean;
  onDelete: () => void;
  onDiscard: () => void;
  onSave: () => void;
  onQueue: () => void;
  onRun: () => void;
  onStop: (runId: string) => void;
}) {
  // When the save/queue/run buttons are disabled, name the unblock condition
  // so a greyed button never reads as broken. Save needs a step; queue/run
  // additionally need an open project folder.
  const noSteps = !hasSteps;
  const saveBlockedReason = noSteps ? 'Add a step first' : undefined;
  const runBlockedReason = noSteps
    ? 'Add a step first'
    : !hasActiveFolder
      ? 'Open a project folder first'
      : undefined;

  return (
    <div className="workflows-editor-actions">
      {workflowId && (
        <button
          className="btn-ghost"
          onClick={() => void onDelete()}
          disabled={deleting}
          style={{ color: 'var(--danger)' }}
        >
          <Trash2 size={12} /> {deleting ? 'Deleting…' : 'Delete'}
        </button>
      )}
      <span style={{ flex: 1 }} />
      {dirty && (
        <button className="btn-ghost" onClick={onDiscard}>
          Discard
        </button>
      )}
      <button
        className="btn-ghost"
        onClick={() => void onSave()}
        disabled={noSteps}
        title={saveBlockedReason}
        aria-label={saveBlockedReason}
      >
        {workflowId ? 'Save' : 'Create'}
      </button>
      <button
        className="btn-ghost"
        onClick={() => void onQueue()}
        disabled={noSteps || !hasActiveFolder}
        title={runBlockedReason}
        aria-label={runBlockedReason}
      >
        <Plus size={11} /> Queue
      </button>
      {runId ? (
        <button
          className="btn-ghost"
          onClick={() => void onStop(runId)}
          style={{ color: 'var(--danger)' }}
        >
          <Square size={11} fill="currentColor" /> Stop
        </button>
      ) : (
        <button
          className="btn-primary"
          onClick={() => void onRun()}
          disabled={noSteps || !hasActiveFolder}
          title={runBlockedReason}
          aria-label={runBlockedReason}
        >
          <Play size={11} fill="currentColor" /> Run
        </button>
      )}
    </div>
  );
}
