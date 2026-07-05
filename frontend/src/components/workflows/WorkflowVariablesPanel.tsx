import { Braces, Info, Plus } from 'lucide-react';
import type { WorkflowVariable } from '../../api';
import { USER_INSTRUCTIONS_VAR } from './promptVariables';
import { WorkflowVariableCard } from './WorkflowVariableCard';
import { useWorkflowVariablesPanelState } from './useWorkflowVariablesPanelState';

// The "Variables" section at the top of the workflow editor. Each variable is
// a collapsible card (like the step rows) holding a name + a free-form value
// textarea. The built-in `user_instructions` variable is always present and
// can't be renamed or removed. Anything a step prompt references as
// `{{name}}` is substituted with the matching value before the prompt is sent
// to an agent (done server-side in renderStepMarkdown).
export function WorkflowVariablesPanel({
  variables,
  onPatch,
  onAdd,
  onRemove,
}: {
  variables: WorkflowVariable[];
  onPatch: (idx: number, patch: Partial<WorkflowVariable>) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  const { isCollapsed, toggle, showInfo, setShowInfo, copiedId, copyToken } =
    useWorkflowVariablesPanelState();

  // Custom variable names that collide with another variable's name. Built-in
  // and empty names are excluded; substitution silently shadows on a clash.
  const nameCounts = new Map<string, number>();
  for (const v of variables) {
    if (v.name) nameCounts.set(v.name, (nameCounts.get(v.name) ?? 0) + 1);
  }

  return (
    <div className="workflows-vars">
      <div className="workflows-vars-head">
        <Braces size={12} className="workflows-vars-head-icon" aria-hidden />
        <span className="workflows-vars-title">Variables</span>
        <div className="workflows-vars-info-wrap">
          <button
            type="button"
            className="icon-btn sm"
            onClick={() => setShowInfo((v) => !v)}
            title="How variables work"
            aria-label="How variables work"
            aria-expanded={showInfo}
          >
            <Info size={12} />
          </button>
          {showInfo && (
            <div className="workflows-vars-info-popover" role="note">
              <p>
                Reference a variable from any step prompt by writing{' '}
                <code>{'{{variable_name}}'}</code>. When the workflow runs,
                Lattice replaces each reference with the variable's text before
                sending the prompt to the agent.
              </p>
              <p>
                By default every built-in step ends with{' '}
                <code>{'{{user_instructions}}'}</code>, so whatever you type in
                the <strong>user_instructions</strong> box below is appended to
                each step automatically. Add your own variables for anything
                else you want to reuse across steps.
              </p>
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="workflows-vars-add"
          onClick={onAdd}
          title="Add a custom variable"
        >
          <Plus size={11} /> Add variable
        </button>
      </div>

      <div className="workflows-vars-list">
        {variables.map((v, idx) => {
          const builtin = v.name === USER_INSTRUCTIONS_VAR;
          const duplicate = !builtin && !!v.name && (nameCounts.get(v.name) ?? 0) > 1;
          return (
            <WorkflowVariableCard
              key={v.id}
              variable={v}
              index={idx}
              duplicate={duplicate}
              collapsed={isCollapsed(v.id)}
              copied={copiedId === v.id}
              onToggle={toggle}
              onCopyToken={copyToken}
              onPatch={onPatch}
              onRemove={onRemove}
            />
          );
        })}
      </div>
    </div>
  );
}
