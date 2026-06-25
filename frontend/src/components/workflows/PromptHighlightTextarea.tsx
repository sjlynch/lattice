import { memo, useMemo, useRef } from 'react';
import type { WorkflowStep } from '../../api';
import { splitPromptSegments } from './promptVariables';
import { useAutosizedTextarea } from './StepRowHooks';

// The prompt editor for an agent step: a colorized overlay rendered behind the
// transparent-text textarea so `{{variable}}` references stand out, plus the
// textarea itself. The overlay mirrors the textarea's box model exactly (see
// steps.css) so the glyphs line up; it's aria-hidden because the textarea is the
// real control.
//
// Memoized and fed only the prompt-related props so editing the step's
// title/mode/harness (all in the sibling `AgentStepHeader`) doesn't re-tokenize
// the prompt — the per-row hot path. It owns its own textarea ref + autosize
// hook and stays mounted across collapse (rendering nothing while collapsed) so
// that ref and the hook order stay stable.
export const PromptHighlightTextarea = memo(function PromptHighlightTextarea({
  index,
  prompt,
  definedNames,
  collapsed,
  onChange,
}: {
  index: number;
  prompt: string;
  definedNames: ReadonlySet<string>;
  collapsed: boolean;
  onChange: (index: number, patch: Partial<WorkflowStep>) => void;
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useAutosizedTextarea(promptRef, prompt, collapsed);
  // Tokenizing the prompt is the per-row hot path; only redo it when the prompt
  // text or the set of defined variable names actually changes.
  const segments = useMemo(
    () => splitPromptSegments(prompt, definedNames),
    [prompt, definedNames],
  );

  if (collapsed) return null;

  return (
    <div className="workflows-step-prompt-wrap">
      <div className="workflows-step-prompt-highlight" aria-hidden>
        {segments.map((seg, i) =>
          seg.token ? (
            <mark
              key={i}
              className={`workflows-step-prompt-token${seg.known ? '' : ' unknown'}`}
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
        {'\n'}
      </div>
      <textarea
        ref={promptRef}
        className="task-card-form-input task-card-form-textarea workflows-step-prompt"
        placeholder="Prompt — written into LATTICE_TASK.md as the task description."
        value={prompt}
        onChange={(e) => onChange(index, { prompt: e.target.value })}
        spellCheck={false}
      />
    </div>
  );
});
