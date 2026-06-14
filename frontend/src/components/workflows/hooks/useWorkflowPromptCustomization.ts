import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  getWorkflowPromptCustomization,
  startWorkflowPromptCustomization,
  type WorkflowPromptTemplateId,
  type WorkflowStep,
} from '../../../api';
import type { Ctx } from '../../../terminal/terminalTypes';
import { normalizeAgentHarness } from '../../../harnesses';
import type { EditorState } from '../editorState';
import {
  inferPromptTemplateId,
  promptTemplateTitle,
} from '../projectPromptVariants';

export const WORKFLOW_PROMPT_CUSTOMIZATION_POLL_INTERVAL_MS = 2000;
export const WORKFLOW_PROMPT_CUSTOMIZATION_MAX_ATTEMPTS = 180;

type Args = {
  activeFolder: string;
  steps: WorkflowStep[];
  setEditor: Dispatch<SetStateAction<EditorState>>;
  addTerminal: Ctx['addTerminal'];
  showError: (message: string) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Owns the workflow prompt-customization session lifecycle: prompting for
// custom-step instructions, spawning the selected harness terminal, polling the
// backend registry, and patching the editor when the revised prompt arrives.
export function useWorkflowPromptCustomization({
  activeFolder,
  steps,
  setEditor,
  addTerminal,
  showError,
}: Args) {
  const [customizingSteps, setCustomizingSteps] = useState<Record<string, string>>({});

  // Read the latest steps through a ref so `customizeStepPrompt` stays
  // referentially stable. Otherwise it would be recreated on every keystroke
  // (steps change on each edit) and break the memoization of every StepRow it's
  // passed to as `onCustomize`.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const customizeStepPrompt = useCallback(async (index: number) => {
    if (!activeFolder) {
      showError('Choose an active project before customizing a workflow prompt.');
      return;
    }
    const step = stepsRef.current[index];
    if (!step) return;

    const inferredTemplateId = step.prompt.trim()
      ? (inferPromptTemplateId(step) as WorkflowPromptTemplateId | null)
      : null;
    let customInstructions: string | undefined;
    if (!inferredTemplateId) {
      const response = window.prompt(
        'How should this custom workflow step be tailored to the active project?',
      );
      if (response === null) return;
      customInstructions = response.trim();
      if (!customInstructions) {
        showError('Customization instructions are required for non-template steps.');
        return;
      }
    }

    const harness = normalizeAgentHarness(step.harness);
    setCustomizingSteps((cur) => ({ ...cur, [step.id]: 'starting' }));
    try {
      const templateTitle = promptTemplateTitle(inferredTemplateId);
      const request = await startWorkflowPromptCustomization({
        project: activeFolder,
        stepTitle: step.title.trim() || `Step ${index + 1}`,
        prompt: step.prompt,
        ...(inferredTemplateId ? { templateId: inferredTemplateId } : {}),
        ...(templateTitle ? { templateTitle } : {}),
        ...(customInstructions ? { customInstructions } : {}),
        harness,
      });
      setCustomizingSteps((cur) => ({ ...cur, [step.id]: request.id }));
      addTerminal({
        label: `customize:${step.title.trim() || index + 1}`,
        cwd: request.cwd,
        initialCommand: request.command,
        projectPath: activeFolder,
        serverId: request.serverId,
      });

      void (async () => {
        try {
          for (let attempt = 0; attempt < WORKFLOW_PROMPT_CUSTOMIZATION_MAX_ATTEMPTS; attempt += 1) {
            await sleep(WORKFLOW_PROMPT_CUSTOMIZATION_POLL_INTERVAL_MS);
            const latest = await getWorkflowPromptCustomization(request.id);
            if (latest.status === 'completed' && latest.resultPrompt) {
              setEditor((cur) => {
                const idx = cur.steps.findIndex((candidate) => candidate.id === step.id);
                if (idx === -1) return cur;
                const nextSteps = cur.steps.map((candidate, i) =>
                  i === idx ? { ...candidate, prompt: latest.resultPrompt! } : candidate,
                );
                return { ...cur, steps: nextSteps, dirty: true };
              });
              return;
            }
            if (latest.status === 'errored') {
              showError(`Prompt customization failed: ${latest.error ?? 'unknown error'}`);
              return;
            }
          }
          showError('Prompt customization is still running; check the customization terminal.');
        } catch (err) {
          showError(`Prompt customization polling failed: ${(err as Error).message}`);
        } finally {
          setCustomizingSteps((cur) => {
            const next = { ...cur };
            delete next[step.id];
            return next;
          });
        }
      })();
    } catch (err) {
      setCustomizingSteps((cur) => {
        const next = { ...cur };
        delete next[step.id];
        return next;
      });
      showError(`Prompt customization failed: ${(err as Error).message}`);
    }
  }, [activeFolder, addTerminal, setEditor, showError]);

  return { customizingSteps, customizeStepPrompt };
}
