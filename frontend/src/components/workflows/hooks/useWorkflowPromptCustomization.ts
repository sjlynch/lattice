import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  getWorkflowPromptCustomization,
  startWorkflowPromptCustomization,
  type WorkflowPromptCustomization,
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

// Dependencies for the prompt-customization poll loop, injected so the loop is
// free of React and timer globals (and thus unit-testable). `isCancelled`
// returns true once the customization's owning session ends — the hook
// unmounted or the active project changed — at which point every post-await
// result is dropped: a customization started for project A can never patch the
// editor or toast an error against project B, and the ~6-minute poll never
// setStates after unmount.
export type PromptCustomizationPollDeps = {
  getStatus: (id: string) => Promise<WorkflowPromptCustomization>;
  sleep: (ms: number) => Promise<void>;
  isCancelled: () => boolean;
  onCompleted: (resultPrompt: string) => void;
  onError: (message: string) => void;
  onExhausted: () => void;
  onSettled: () => void;
};

// Poll the backend registry until the customization completes, errors, or the
// attempt budget is exhausted. Every state-producing callback is gated behind
// `isCancelled()` (checked after each await) so a cancelled session emits
// nothing but the `onSettled` cleanup.
export async function pollPromptCustomization(
  id: string,
  deps: PromptCustomizationPollDeps,
): Promise<void> {
  const { getStatus, sleep: wait, isCancelled } = deps;
  try {
    for (
      let attempt = 0;
      attempt < WORKFLOW_PROMPT_CUSTOMIZATION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      await wait(WORKFLOW_PROMPT_CUSTOMIZATION_POLL_INTERVAL_MS);
      if (isCancelled()) return;
      const latest = await getStatus(id);
      if (isCancelled()) return;
      if (latest.status === 'completed' && latest.resultPrompt) {
        deps.onCompleted(latest.resultPrompt);
        return;
      }
      if (latest.status === 'errored') {
        deps.onError(
          `Prompt customization failed: ${latest.error ?? 'unknown error'}`,
        );
        return;
      }
    }
    if (isCancelled()) return;
    deps.onExhausted();
  } catch (err) {
    if (isCancelled()) return;
    deps.onError(
      `Prompt customization polling failed: ${(err as Error).message}`,
    );
  } finally {
    deps.onSettled();
  }
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

  // True only while this hook instance is mounted; the poll loop reads it before
  // its terminal `setCustomizingSteps` so it never sets state after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Each in-flight poll loop captures the current "session" — a token tied to
  // the active project. On unmount OR when `activeFolder` changes the effect
  // cleanup marks that session cancelled, so the loop stops polling and drops
  // any pending setEditor/showError. This guarantees a customization started for
  // project A never patches/toasts project B and kills the setState-after-
  // unmount warnings from the previously un-cancellable ~6-minute poll.
  const sessionRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  useEffect(() => {
    const session = { cancelled: false };
    sessionRef.current = session;
    return () => {
      session.cancelled = true;
    };
  }, [activeFolder]);

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
    // Bind this customization to the active project's session; every result it
    // produces is dropped once the user leaves the project (or the panel).
    const session = sessionRef.current;
    const clearSpinner = () => {
      if (!mountedRef.current) return;
      setCustomizingSteps((cur) => {
        if (!(step.id in cur)) return cur;
        const next = { ...cur };
        delete next[step.id];
        return next;
      });
    };

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
      addTerminal({
        id: request.terminalId,
        label: `customize:${step.title.trim() || index + 1}`,
        cwd: request.cwd,
        initialCommand: request.command,
        projectPath: activeFolder,
        serverId: request.serverId,
      });
      // The user may have left the project/panel during the start request; if so
      // don't begin polling — just drop the spinner.
      if (session.cancelled) {
        clearSpinner();
        return;
      }
      setCustomizingSteps((cur) => ({ ...cur, [step.id]: request.id }));

      void pollPromptCustomization(request.id, {
        getStatus: getWorkflowPromptCustomization,
        sleep,
        isCancelled: () => session.cancelled,
        onCompleted: (resultPrompt) => {
          setEditor((cur) => {
            const idx = cur.steps.findIndex((candidate) => candidate.id === step.id);
            if (idx === -1) return cur;
            const nextSteps = cur.steps.map((candidate, i) =>
              i === idx ? { ...candidate, prompt: resultPrompt } : candidate,
            );
            return { ...cur, steps: nextSteps, dirty: true };
          });
        },
        onError: showError,
        onExhausted: () =>
          showError('Prompt customization is still running; check the customization terminal.'),
        onSettled: clearSpinner,
      });
    } catch (err) {
      clearSpinner();
      if (!session.cancelled) {
        showError(`Prompt customization failed: ${(err as Error).message}`);
      }
    }
  }, [activeFolder, addTerminal, setEditor, showError]);

  return { customizingSteps, customizeStepPrompt };
}
