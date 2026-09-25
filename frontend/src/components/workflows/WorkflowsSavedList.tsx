import { useMemo } from 'react';
import { ListChecks, Plus, X } from 'lucide-react';
import { WORKFLOW_TEMPLATES } from '../../workflowTemplates';
import type { WorkflowRun } from '../../api';
import type { WorkflowManager } from './hooks/useWorkflowManager';
import { WorkflowsSavedItem } from './WorkflowsSavedItem';
import { workflowRunOverrideOptions } from './workflowHarnessOverride';

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
    piMenu,
    queue,
    startingWorkflowIds,
    getWorkflowHarnessOverride,
    getWorkflowPiModelOverride,
    actions,
  } = manager;

  // First active run per workflow id, indexed once. activeRunList is sorted by
  // startedAt, so keeping the first insertion preserves the prior `.find` result.
  const runByWorkflowId = useMemo(() => {
    const map = new Map<string, WorkflowRun>();
    for (const run of activeRunList) {
      if (!map.has(run.workflowId)) map.set(run.workflowId, run);
    }
    return map;
  }, [activeRunList]);

  // Queued-entry counts per workflow id, tallied once instead of a per-row filter.
  const queuedCountByWorkflowId = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of queue.queuedEntries) {
      map.set(entry.workflowId, (map.get(entry.workflowId) ?? 0) + 1);
    }
    return map;
  }, [queue.queuedEntries]);

  // One shared run-override option list ("Default" + harness rows + "Pi — X"
  // model rows). Stable per availability/menu change so the memoized rows don't
  // re-render on every run-progress event.
  const runOverrideOptions = useMemo(
    () => workflowRunOverrideOptions(harnessAvail, piMenu),
    [harnessAvail, piMenu],
  );

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
            const run = runByWorkflowId.get(workflow.id);
            const isSelected = editor.workflowId === workflow.id;
            const queuedCount = queuedCountByWorkflowId.get(workflow.id) ?? 0;
            const harnessOverride = getWorkflowHarnessOverride(workflow.id);
            const piModelOverride = getWorkflowPiModelOverride(workflow.id);
            return (
              <WorkflowsSavedItem
                key={workflow.id}
                workflow={workflow}
                isSelected={isSelected}
                run={run}
                starting={startingWorkflowIds.has(workflow.id)}
                queuedCount={queuedCount}
                harnessOverride={harnessOverride}
                piModelOverride={piModelOverride}
                harnessOptions={runOverrideOptions}
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
