import { useMemo } from 'react';
import { ListChecks, Plus, X } from 'lucide-react';
import { WORKFLOW_TEMPLATES } from '../../workflowTemplates';
import { ALL_AGENT_HARNESSES } from '../../harnesses';
import type {
  WorkflowRun,
  WorkflowRunHarnessOverride,
  WorkflowStepHarness,
} from '../../api';
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

  // Harness-option arrays keyed by override value. There are only a handful of
  // override values, so precompute each once per availability change; reusing the
  // same array reference keeps the memoized rows from re-rendering needlessly.
  const harnessOptionsByOverride = useMemo(() => {
    const map = new Map<WorkflowRunHarnessOverride, WorkflowStepHarness[]>();
    const overrides: WorkflowRunHarnessOverride[] = [null, ...ALL_AGENT_HARNESSES];
    for (const override of overrides) {
      map.set(override, availableWorkflowHarnessOptions(harnessAvail, override));
    }
    return map;
  }, [harnessAvail]);

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
            const harnessOptions =
              harnessOptionsByOverride.get(harnessOverride) ??
              availableWorkflowHarnessOptions(harnessAvail, harnessOverride);
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
