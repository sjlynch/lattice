import { useMemo } from 'react';
import { GitMerge, Play, Plus, Square, Trash2, UploadCloud } from 'lucide-react';
import { DEFAULT_PROMPTS } from './defaultPrompts';
import { promptsWithProjectVariants } from './projectPromptVariants';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { StepRow } from './StepRow';
import { stepRunStatus } from './stepRunStatus';
import { WorkflowEditorEmptyState } from './WorkflowEditorEmptyState';
import { WorkflowRunStrip } from './WorkflowRunStrip';
import { WorkflowVariablesPanel } from './WorkflowVariablesPanel';

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

  // projectProfile is stable across typing, so build the project-tailored
  // quick-add prompts once per profile rather than on every keystroke.
  const projectPrompts = useMemo(
    () => promptsWithProjectVariants(DEFAULT_PROMPTS, projectProfile),
    [projectProfile],
  );

  // Names of variables defined on this workflow, so the step-prompt highlight
  // can distinguish a real `{{var}}` reference from a typo'd / undefined one.
  const definedNames = useMemo(
    () => new Set(editor.variables.map((v) => v.name)),
    [editor.variables],
  );

  // The run whose progress the editor rows should mirror: the active run if
  // one is in flight, else a recently-finished one still lingering in view (so
  // a failed step stays marked red for the ~5min the errored run lingers).
  // Mirrors the precedence WorkflowRunStrip uses (active over recent).
  const statusRun = runForEditor ?? recentForEditor ?? null;

  const quickAddPrompts = (
    <div className="workflows-default-prompts">
      <span className="workflows-default-prompts-label">Quick add</span>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => actions.addControlStep('start')}
        title="Moves every Open task to In Progress and runs each one. Skips silently if Open is empty."
      >
        <Play size={11} />
        Start
      </button>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => actions.addControlStep('merge')}
        title="Waits for In Progress to drain, then merges every Ready-to-Merge task to QA."
      >
        <GitMerge size={11} />
        Merge
      </button>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => actions.addControlStep('push')}
        title="Waits for Ready-to-Merge to drain, then pushes to remote (same as the Task Board cloud icon)."
      >
        <UploadCloud size={11} />
        Push
      </button>
      <span className="workflows-default-prompts-separator" aria-hidden />
      {projectPrompts.map((prompt) => {
        const Icon = prompt.icon;
        return (
          <button
            key={prompt.id}
            type="button"
            className="workflows-prompt-chip"
            onClick={() => actions.addDefaultPromptStep(prompt)}
            title={prompt.prompt}
          >
            <Icon size={11} />
            {prompt.label}
          </button>
        );
      })}
    </div>
  );

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
                  runStatus={stepRunStatus(index, statusRun)}
                  onChange={actions.patchStep}
                  onRemove={actions.removeStep}
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
          {quickAddPrompts}
          <div className="workflows-editor-actions">
            {editor.workflowId && (
              <button
                className="btn-ghost"
                onClick={() => void actions.deleteCurrent()}
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 size={12} /> Delete
              </button>
            )}
            <span style={{ flex: 1 }} />
            {editor.dirty && (
              <button className="btn-ghost" onClick={actions.discardEdits}>
                Discard
              </button>
            )}
            <button
              className="btn-ghost"
              onClick={() => void actions.save()}
              disabled={editor.steps.length === 0}
            >
              {editor.workflowId ? 'Save' : 'Create'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => void actions.enqueueEditorWorkflow()}
              disabled={editor.steps.length === 0 || !activeFolder}
            >
              <Plus size={11} /> Queue
            </button>
            {runForEditor ? (
              <button
                className="btn-ghost"
                onClick={() => void actions.stopRun(runForEditor.id)}
                style={{ color: 'var(--danger)' }}
              >
                <Square size={11} fill="currentColor" /> Stop
              </button>
            ) : (
              <button
                className="btn-primary"
                onClick={() => void actions.runEditorWorkflow()}
                disabled={editor.steps.length === 0 || !activeFolder}
              >
                <Play size={11} fill="currentColor" /> Run
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
