import { Play, Plus, Square, Trash2 } from 'lucide-react';
import { DEFAULT_PROMPTS } from './defaultPrompts';
import { promptsWithProjectVariants } from './projectPromptVariants';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { StepRow } from './StepRow';
import { WorkflowEditorEmptyState } from './WorkflowEditorEmptyState';
import { WorkflowRunStrip } from './WorkflowRunStrip';

type Props = {
  manager: WorkflowManager;
};

export function WorkflowEditorPanel({ manager }: Props) {
  const {
    activeFolder,
    editor,
    runForEditor,
    recentForEditor,
    collapsedSteps,
    harnessAvail,
    projectProfile,
    customizingSteps,
    actions,
  } = manager;

  const projectPrompts = promptsWithProjectVariants(DEFAULT_PROMPTS, projectProfile);

  const quickAddPrompts = (
    <div className="workflows-default-prompts">
      <span className="workflows-default-prompts-label">Quick add</span>
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
                summary={!runForEditor ? recentForEditor ?? null : null}
                onStop={runForEditor ? () => void actions.stopRun(runForEditor.id) : undefined}
                onDismiss={() => {
                  if (recentForEditor) actions.dismissRecent(recentForEditor.id);
                }}
              />
            )}
          </div>
          <div className="workflows-editor-steps">
            {editor.steps.map((step, index) => (
              <StepRow
                key={step.id}
                step={step}
                index={index}
                collapsed={collapsedSteps.isCollapsed(step.id)}
                harnessAvail={harnessAvail}
                onChange={(patch) => actions.patchStep(index, patch)}
                onRemove={() => actions.removeStep(index)}
                onReorder={actions.reorderSteps}
                onToggleCollapse={() => collapsedSteps.toggleCollapsed(step.id)}
                onCustomize={() => void actions.customizeStepPrompt(index)}
                customizing={Boolean(customizingSteps[step.id])}
              />
            ))}
            <button className="workflows-add-step" onClick={actions.addStep}>
              <Plus size={12} /> Add step
            </button>
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
