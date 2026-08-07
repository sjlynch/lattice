import { useCallback, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { StepRow } from './StepRow';
import { stepRunStatus } from './stepRunStatus';
import { WorkflowEditorActions } from './WorkflowEditorActions';
import { WorkflowEditorEmptyState } from './WorkflowEditorEmptyState';
import { WorkflowQuickAddBar } from './WorkflowQuickAddBar';
import { WorkflowRunStrip } from './WorkflowRunStrip';
import { WorkflowVariablesPanel } from './WorkflowVariablesPanel';
import { useConfirm } from '../shared/ConfirmDialog';

type Props = {
  manager: WorkflowManager;
};

export function WorkflowEditorPanel({ manager }: Props) {
  const {
    activeFolder,
    editor,
    runForEditor,
    controlProgressForEditor,
    recentForEditor,
    collapsedSteps,
    harnessAvail,
    piMenu,
    projectProfile,
    customizingSteps,
    actions,
  } = manager;

  // Names of variables defined on this workflow, so the step-prompt highlight
  // can distinguish a real `{{var}}` reference from a typo'd / undefined one.
  const definedNames = useMemo(
    () => new Set(editor.variables.map((v) => v.name)),
    [editor.variables],
  );

  const { confirm } = useConfirm();
  const [deletingWorkflow, setDeletingWorkflow] = useState(false);

  // Depend on the individual (stable) action callbacks, not the `actions`
  // object — that object is rebuilt each render, and a fresh onRemove identity
  // would re-render every memoized StepRow on each keystroke.
  const { removeStep, deleteCurrent } = actions;

  // Deleting a step permanently drops its prompt body — confirm first.
  const handleRemoveStep = useCallback(
    async (index: number) => {
      const ok = await confirm({
        title: 'Delete step',
        message: 'Delete this step? Its prompt will be lost.',
        confirmLabel: 'Delete',
      });
      if (ok) removeStep(index);
    },
    [confirm, removeStep],
  );

  const handleDeleteWorkflow = useCallback(async () => {
    if (deletingWorkflow) return;
    const ok = await confirm({
      title: 'Delete workflow',
      message: 'Delete this workflow? This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setDeletingWorkflow(true);
    try {
      await deleteCurrent();
    } finally {
      setDeletingWorkflow(false);
    }
  }, [confirm, deleteCurrent, deletingWorkflow]);

  // The run whose progress the editor rows should mirror: the active run if
  // one is in flight, else a recently-finished one still lingering in view (so
  // a failed step stays marked red for the ~5min the errored run lingers).
  // Mirrors the precedence WorkflowRunStrip uses (active over recent).
  const statusRun = runForEditor ?? recentForEditor ?? null;

  return (
    <section className="workflows-editor">
      {editor.workflowId === null && editor.steps.length === 0 ? (
        <WorkflowEditorEmptyState manager={manager} />
      ) : (
        <>
          <div className="workflows-editor-head">
            <input
              className="task-card-form-input workflows-editor-name"
              placeholder="Workflow name"
              value={editor.name}
              onChange={(event) => actions.updateEditorName(event.target.value)}
            />
            {(runForEditor || recentForEditor) && (
              <WorkflowRunStrip
                active={runForEditor ?? null}
                controlProgress={controlProgressForEditor ?? null}
                summary={!runForEditor ? recentForEditor ?? null : null}
                onStop={runForEditor ? () => void actions.stopRun(runForEditor.id) : undefined}
                onDismiss={() => {
                  if (recentForEditor) actions.dismissRecent(recentForEditor.id);
                }}
              />
            )}
          </div>
          {/* Variables + steps share one scroll container so the variables
              section scrolls up/down with the steps instead of staying pinned
              as a sticky header. It keeps its own border/label so it reads as a
              distinct section while scrolling. */}
          <div className="workflows-editor-scroll">
            <WorkflowVariablesPanel
              variables={editor.variables}
              onPatch={actions.patchVariable}
              onAdd={actions.addVariable}
              onRemove={actions.removeVariable}
            />
            <div className="workflows-editor-steps">
              {editor.steps.map((step, index) => (
                <StepRow
                  key={step.id}
                  step={step}
                  index={index}
                  collapsed={collapsedSteps.isCollapsed(step.id)}
                  harnessAvail={harnessAvail}
                  piMenu={piMenu}
                  definedNames={definedNames}
                  runStatus={stepRunStatus(index, statusRun, step.frozen === true)}
                  onChange={actions.patchStep}
                  onRemove={handleRemoveStep}
                  onReorder={actions.reorderSteps}
                  onToggleCollapse={collapsedSteps.toggleCollapsed}
                  onCustomize={actions.customizeStepPrompt}
                  customizing={Boolean(customizingSteps[step.id])}
                />
              ))}
              <button className="workflows-add-step" onClick={actions.addStep}>
                <Plus size={12} /> Add step
              </button>
            </div>
          </div>
          <WorkflowQuickAddBar
            projectProfile={projectProfile}
            onAddControlStep={actions.addControlStep}
            onAddDefaultPromptStep={actions.addDefaultPromptStep}
          />
          <WorkflowEditorActions
            workflowId={editor.workflowId}
            dirty={editor.dirty}
            hasSteps={editor.steps.length > 0}
            hasRunnableSteps={editor.steps.some((s) => s.frozen !== true)}
            hasActiveFolder={Boolean(activeFolder)}
            runId={runForEditor?.id ?? null}
            deleting={deletingWorkflow}
            onDelete={handleDeleteWorkflow}
            onDiscard={actions.discardEdits}
            onSave={actions.save}
            onQueue={actions.enqueueEditorWorkflow}
            onRun={actions.runEditorWorkflow}
            onStop={actions.stopRun}
          />
        </>
      )}
    </section>
  );
}
