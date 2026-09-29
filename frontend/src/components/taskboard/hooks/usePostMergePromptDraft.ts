import { useEffect, useRef, useState } from 'react';

const POST_MERGE_PROMPT_DEBOUNCE_MS = 250;

type PostMergePromptDraft = {
  draftPrompt: string;
  setDraftPrompt: (value: string) => void;
};

export function usePostMergePromptDraft(
  prompt: string,
  onSavePrompt: (value: string) => void,
): PostMergePromptDraft {
  const [draftPrompt, setDraftPrompt] = useState(prompt);
  const draftRef = useRef(prompt);

  // Keep local draft in sync with persisted value when it changes externally
  // (folder switch, another tab updating settings, etc.).
  useEffect(() => {
    if (prompt !== draftRef.current) {
      setDraftPrompt(prompt);
      draftRef.current = prompt;
    }
  }, [prompt]);

  // Debounced persist on prompt edits — same pattern as other settings
  // controls in the codebase (250 ms balances "feels live" with not
  // hammering the file-write side of /api/settings).
  useEffect(() => {
    if (draftPrompt === prompt) return;
    const handle = window.setTimeout(() => {
      draftRef.current = draftPrompt;
      onSavePrompt(draftPrompt);
    }, POST_MERGE_PROMPT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftPrompt, prompt, onSavePrompt]);

  return { draftPrompt, setDraftPrompt };
}
