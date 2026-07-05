import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { WorkflowVariable } from '../../api';
import { sanitizeVariableNameInput, USER_INSTRUCTIONS_VAR } from './promptVariables';

// One collapsible variable card in the WorkflowVariablesPanel: the name input,
// the `{{token}}` copy button, the remove button, and the value textarea. The
// built-in `user_instructions` variable renders read-only and without a remove
// button. `duplicate`/`collapsed`/`copied` are derived by the parent panel
// (name-collision counting and the shared UI state) and passed in.
export function WorkflowVariableCard({
  variable,
  index,
  duplicate,
  collapsed,
  copied,
  onToggle,
  onCopyToken,
  onPatch,
  onRemove,
}: {
  variable: WorkflowVariable;
  index: number;
  duplicate: boolean;
  collapsed: boolean;
  copied: boolean;
  onToggle: (id: string) => void;
  onCopyToken: (v: WorkflowVariable) => void;
  onPatch: (idx: number, patch: Partial<WorkflowVariable>) => void;
  onRemove: (idx: number) => void;
}) {
  const builtin = variable.name === USER_INSTRUCTIONS_VAR;
  return (
    <div className={`workflows-var ${collapsed ? 'collapsed' : ''}`}>
      <div className="workflows-var-row">
        <button
          type="button"
          className="icon-btn sm workflows-var-collapse"
          onClick={() => onToggle(variable.id)}
          title={collapsed ? 'Expand variable' : 'Collapse variable'}
          aria-label={collapsed ? 'Expand variable' : 'Collapse variable'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <input
          className={`task-card-form-input workflows-var-name${
            duplicate ? ' workflows-var-name--dup' : ''
          }`}
          value={variable.name}
          placeholder="variable_name"
          readOnly={builtin}
          disabled={builtin}
          title={
            builtin
              ? 'Built-in variable — appended to every built-in step'
              : duplicate
                ? 'Variable name already in use'
                : 'Variable name (letters, digits, underscores)'
          }
          onChange={(e) =>
            onPatch(index, { name: sanitizeVariableNameInput(e.target.value) })
          }
        />
        <button
          type="button"
          className="workflows-var-token"
          onClick={() => onCopyToken(variable)}
          disabled={!variable.name}
          title={
            !variable.name
              ? 'Name this variable to reference it'
              : copied
                ? 'Copied!'
                : 'Click to copy — reference this in a step prompt'
          }
          aria-label={
            variable.name
              ? `Copy {{${variable.name}}} to clipboard`
              : 'Variable reference token'
          }
        >
          {copied ? 'Copied!' : `{{${variable.name || '…'}}}`}
        </button>
        {!builtin && (
          <button
            className="icon-btn sm"
            onClick={() => onRemove(index)}
            title="Remove variable"
            aria-label="Remove variable"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {!collapsed && (
        <textarea
          className="task-card-form-input task-card-form-textarea workflows-var-value"
          placeholder={
            builtin
              ? 'Instructions injected into every step that includes {{user_instructions}} (leave empty for none).'
              : 'Value substituted wherever this variable is referenced.'
          }
          value={variable.value}
          onChange={(e) => onPatch(index, { value: e.target.value })}
        />
      )}
    </div>
  );
}
