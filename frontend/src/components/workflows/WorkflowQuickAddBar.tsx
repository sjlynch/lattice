import { useMemo } from 'react';
import { GitMerge, Play, UploadCloud } from 'lucide-react';
import type { WorkflowStepKind } from '../../api';
import { DEFAULT_PROMPTS, type DefaultPrompt } from './defaultPrompts';
import { promptsWithProjectVariants } from './projectPromptVariants';
import type { ProjectPromptProfile } from './projectStackDetection';

// The quick-add bar at the bottom of the editor: the Start/Merge/Push control
// chips plus one chip per project-tailored default prompt. Each click appends a
// new step seeded from that control/prompt.
export function WorkflowQuickAddBar({
  projectProfile,
  onAddControlStep,
  onAddDefaultPromptStep,
}: {
  projectProfile: ProjectPromptProfile | null;
  onAddControlStep: (kind: WorkflowStepKind) => void;
  onAddDefaultPromptStep: (prompt: DefaultPrompt) => void;
}) {
  // projectProfile is stable across typing, so build the project-tailored
  // quick-add prompts once per profile rather than on every keystroke.
  const projectPrompts = useMemo(
    () => promptsWithProjectVariants(DEFAULT_PROMPTS, projectProfile),
    [projectProfile],
  );

  return (
    <div className="workflows-default-prompts">
      <span className="workflows-default-prompts-label">Quick add</span>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => onAddControlStep('start')}
        title="Moves every Open task to In Progress and runs each one. Skips silently if Open is empty."
      >
        <Play size={11} />
        Start
      </button>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => onAddControlStep('merge')}
        title="Waits for In Progress to drain, then merges every Ready-to-Merge task to QA."
      >
        <GitMerge size={11} />
        Merge
      </button>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => onAddControlStep('push')}
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
            onClick={() => onAddDefaultPromptStep(prompt)}
            title={prompt.prompt}
          >
            <Icon size={11} />
            {prompt.label}
          </button>
        );
      })}
    </div>
  );
}
