import { useEffect, useRef, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, Info, Plus, X } from 'lucide-react';
import type { WorkflowVariable } from '../../api';
import {
  copyVariableToken,
  sanitizeVariableNameInput,
  USER_INSTRUCTIONS_VAR,
} from './promptVariables';

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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showInfo, setShowInfo] = useState(false);
  // Id of the variable whose `{{token}}` was just click-copied (drives the
  // brief "Copied!" label swap). A single ref-held timer resets it after ~1.5s.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const toggle = (id: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copyToken = (v: WorkflowVariable) => {
    // The write can reject (denied permission, non-secure context, unfocused
    // document); only flip to "Copied!" once it has actually landed, otherwise
    // we'd give false success feedback for an empty clipboard.
    void copyVariableToken(v.name).then((ok) => {
      if (!ok) return;
      setCopiedId(v.id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
    });
  };

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
          const isCollapsed = collapsed.has(v.id);
          const duplicate = !builtin && !!v.name && (nameCounts.get(v.name) ?? 0) > 1;
          const copied = copiedId === v.id;
          return (
            <div
              key={v.id}
              className={`workflows-var ${isCollapsed ? 'collapsed' : ''}`}
            >
              <div className="workflows-var-row">
                <button
                  type="button"
                  className="icon-btn sm workflows-var-collapse"
                  onClick={() => toggle(v.id)}
                  title={isCollapsed ? 'Expand variable' : 'Collapse variable'}
                  aria-label={isCollapsed ? 'Expand variable' : 'Collapse variable'}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                <input
                  className={`task-card-form-input workflows-var-name${
                    duplicate ? ' workflows-var-name--dup' : ''
                  }`}
                  value={v.name}
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
                    onPatch(idx, { name: sanitizeVariableNameInput(e.target.value) })
                  }
                />
                <button
                  type="button"
                  className="workflows-var-token"
                  onClick={() => copyToken(v)}
                  disabled={!v.name}
                  title={
                    !v.name
                      ? 'Name this variable to reference it'
                      : copied
                        ? 'Copied!'
                        : 'Click to copy — reference this in a step prompt'
                  }
                  aria-label={
                    v.name
                      ? `Copy {{${v.name}}} to clipboard`
                      : 'Variable reference token'
                  }
                >
                  {copied ? 'Copied!' : `{{${v.name || '…'}}}`}
                </button>
                {!builtin && (
                  <button
                    className="icon-btn sm"
                    onClick={() => onRemove(idx)}
                    title="Remove variable"
                    aria-label="Remove variable"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <textarea
                  className="task-card-form-input task-card-form-textarea workflows-var-value"
                  placeholder={
                    builtin
                      ? 'Instructions injected into every step that includes {{user_instructions}} (leave empty for none).'
                      : 'Value substituted wherever this variable is referenced.'
                  }
                  value={v.value}
                  onChange={(e) => onPatch(idx, { value: e.target.value })}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
