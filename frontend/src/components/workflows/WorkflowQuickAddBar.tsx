import { useMemo } from 'react';
import { FlaskConical, GitMerge, Play, UploadCloud } from 'lucide-react';
import type { WorkflowStepKind } from '../../api';
import { DEFAULT_PROMPTS, type DefaultPrompt } from './defaultPrompts';
import { promptsWithProjectVariants } from './projectPromptVariants';
import type { ProjectPromptProfile } from './projectStackDetection';
import { RUN_TESTS_STEP_HINT } from './TestStepRow';
import { startQuickAddDrag } from './useQuickAddDragDrop';

// The quick-add bar at the bottom of the editor: the Start/Merge/Run tests/Push
// step chips plus one chip per project-tailored default prompt. Each click appends a
// new step seeded from that control/prompt; dragging inserts it in the list.
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
      <span className="workflows-default-prompts-label" title="Click to append a step, or drag it into position">
        Quick add <span className="workflows-default-prompts-hint">Click to add · drag to insert</span>
      </span>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => onAddControlStep('start')}
        draggable
        onDragStart={(event) => startQuickAddDrag(event, { kind: 'control', stepKind: 'start' })}
        title="Moves every Open task to In Progress and runs each one. Skips silently if Open is empty."
      >
        <Play size={11} />
        Start
      </button>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => onAddControlStep('merge')}
        draggable
        onDragStart={(event) => startQuickAddDrag(event, { kind: 'control', stepKind: 'merge' })}
        title="Waits for In Progress to drain, then merges every Ready-to-Merge task to QA."
      >
        <GitMerge size={11} />
        Merge
      </button>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => onAddControlStep('test')}
        draggable
        onDragStart={(event) => startQuickAddDrag(event, { kind: 'control', stepKind: 'test' })}
        title={RUN_TESTS_STEP_HINT}
      >
        <FlaskConical size={11} />
        Run tests
      </button>
      <button
        type="button"
        className="workflows-prompt-chip workflows-prompt-chip-control"
        onClick={() => onAddControlStep('push')}
        draggable
        onDragStart={(event) => startQuickAddDrag(event, { kind: 'control', stepKind: 'push' })}
        title="Waits for Ready-to-Merge to drain, then pushes the commits already on the branch — it never stages or commits your uncommitted files."
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
            draggable
            onDragStart={(event) => startQuickAddDrag(event, { kind: 'prompt', promptId: prompt.id })}
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
