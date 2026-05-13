import { ListChecks, Plus } from 'lucide-react';
import { DEFAULT_PROMPTS } from './defaultPrompts';
import type { WorkflowManager } from './hooks/useWorkflowManager';

type Props = {
  manager: WorkflowManager;
};

export function WorkflowEditorEmptyState({ manager }: Props) {
  const { actions } = manager;

  return (
    <div className="workflows-editor-empty">
      <ListChecks size={28} />
      <div className="workflows-editor-empty-title">
        Build a chain of prompts.
      </div>
      <div className="workflows-editor-empty-sub">
        Each step becomes a task on the board. Run each step manually; when it
        merges and reaches QA, the next step appears automatically.
      </div>
      <div className="workflows-editor-empty-actions">
        <button className="btn-primary" onClick={actions.newBlank}>
          <Plus size={12} /> New blank
        </button>
        <button
          className="btn-ghost"
          onClick={() => actions.setPickingTemplate(true)}
        >
          <ListChecks size={12} /> From template
        </button>
      </div>
      <div className="workflows-default-prompts">
        <span className="workflows-default-prompts-label">Quick add</span>
        {DEFAULT_PROMPTS.map((prompt) => {
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
    </div>
  );
}
