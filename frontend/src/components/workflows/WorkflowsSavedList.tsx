import { ListChecks, Play, Plus, Square, X } from 'lucide-react';
import { WORKFLOW_TEMPLATES } from '../../workflowTemplates';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import {
  availableWorkflowHarnessOptions,
  parseWorkflowHarnessOverride,
  serializeWorkflowHarnessOverride,
  workflowHarnessOverrideLabel,
} from './workflowHarnessOverride';

type Props = {
  manager: WorkflowManager;
};

export function WorkflowsSavedList({ manager }: Props) {
  const {
    editor,
    sortedWorkflows,
    activeRunList,
    pickingTemplate,
    harnessAvail,
    queue,
    getWorkflowHarnessOverride,
    actions,
  } = manager;

  return (
    <aside className="workflows-list">
      <div className="workflows-list-head">
        <span className="workflows-list-title">Saved</span>
        <div className="workflows-list-actions">
          <button
            className="icon-btn sm"
            onClick={() => actions.setPickingTemplate((v) => !v)}
            title="New from template"
            aria-label="New from template"
          >
            <ListChecks size={12} />
          </button>
          <button
            className="icon-btn sm"
            onClick={actions.newBlank}
            title="New blank workflow"
            aria-label="New blank workflow"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      {pickingTemplate && (
        <div className="workflows-templates">
          <div className="workflows-templates-head">
            <span>Templates</span>
            <button
              className="icon-btn sm"
              onClick={() => actions.setPickingTemplate(false)}
              aria-label="Close templates"
            >
              <X size={12} />
            </button>
          </div>
          {WORKFLOW_TEMPLATES.map((template) => (
            <button
              key={template.id}
              className="workflows-template"
              onClick={() => void actions.newFromTemplate(template)}
              title={template.description}
            >
              <div className="workflows-template-name">{template.name}</div>
              <div className="workflows-template-desc">{template.description}</div>
            </button>
          ))}
        </div>
      )}
      <div className="workflows-list-items">
        {sortedWorkflows.length === 0 ? (
          <div className="workflows-empty">
            No workflows yet. Click <Plus size={11} style={{ verticalAlign: -1 }} /> to
            create one, or <ListChecks size={11} style={{ verticalAlign: -1 }} /> for
            a template.
          </div>
        ) : (
          sortedWorkflows.map((workflow) => {
            const run = activeRunList.find((r) => r.workflowId === workflow.id);
            const isSelected = editor.workflowId === workflow.id;
            const queuedCount = queue.queuedEntries.filter(
              (entry) => entry.workflowId === workflow.id,
            ).length;
            const harnessOverride = getWorkflowHarnessOverride(workflow.id);
            const harnessOptions = availableWorkflowHarnessOptions(
              harnessAvail,
              harnessOverride,
            );
            return (
              <div
                key={workflow.id}
                className={`workflows-item ${isSelected ? 'active' : ''}`}
                onClick={() => actions.selectWorkflow(workflow)}
              >
                <div className="workflows-item-name">{workflow.name}</div>
                <div className="workflows-item-meta">
                  {workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'}
                  {queuedCount > 0 && (
                    <>
                      {' · '}
                      <span className="workflows-item-queued">
                        queued{queuedCount > 1 ? ` ×${queuedCount}` : ''}
                      </span>
                    </>
                  )}
                  {run && (
                    <>
                      {' · '}
                      <span className="workflows-item-run">
                        running {run.currentStepIndex + 1}/{run.totalSteps}
                      </span>
                    </>
                  )}
                </div>
                <div className="workflows-item-actions">
                  {run ? (
                    <button
                      className="workflows-item-run-btn danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        void actions.stopRun(run.id);
                      }}
                      title="Stop workflow run"
                      aria-label="Stop workflow run"
                    >
                      <Square size={10} fill="currentColor" />
                    </button>
                  ) : (
                    <>
                      <select
                        className="workflows-item-harness workflows-step-harness"
                        value={serializeWorkflowHarnessOverride(harnessOverride)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          event.stopPropagation();
                          actions.setWorkflowHarnessOverride(
                            workflow.id,
                            parseWorkflowHarnessOverride(event.target.value),
                          );
                        }}
                        title="Run override: Default uses each step's harness"
                        aria-label={`Run override for ${workflow.name}`}
                      >
                        <option value="default">Default</option>
                        {harnessOptions.map((harness) => (
                          <option key={harness} value={harness}>
                            {workflowHarnessOverrideLabel(harness)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="workflows-item-run-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          actions.enqueueWorkflow(workflow.id);
                        }}
                        disabled={workflow.steps.length === 0}
                        title={
                          workflow.steps.length === 0
                            ? 'Add steps before queueing'
                            : 'Add to queue'
                        }
                        aria-label="Add workflow to queue"
                      >
                        <Plus size={12} />
                      </button>
                      <button
                        className="workflows-item-run-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          void actions.runWorkflow(workflow.id);
                        }}
                        disabled={workflow.steps.length === 0}
                        title={
                          workflow.steps.length === 0
                            ? 'Add steps before running'
                            : 'Run workflow now'
                        }
                        aria-label="Run workflow now"
                      >
                        <Play size={11} fill="currentColor" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
