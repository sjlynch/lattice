import { ListChecks, Plus, X } from 'lucide-react';
import { WORKFLOW_TEMPLATES } from '../../workflowTemplates';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { WorkflowsSavedItem } from './WorkflowsSavedItem';
import { availableWorkflowHarnessOptions } from './workflowHarnessOverride';

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
              <WorkflowsSavedItem
                key={workflow.id}
                workflow={workflow}
                isSelected={isSelected}
                run={run}
                queuedCount={queuedCount}
                harnessOverride={harnessOverride}
                harnessOptions={harnessOptions}
                onSelect={actions.selectWorkflow}
                onSetHarnessOverride={actions.setWorkflowHarnessOverride}
                onEnqueue={actions.enqueueWorkflow}
                onRun={actions.runWorkflow}
                onStopRun={actions.stopRun}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}
