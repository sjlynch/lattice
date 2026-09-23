import { useEffect, useState } from 'react';
import { fetchUserSettings, type UserSettings } from '../../../api';

// Whether the project has a post-merge hook prompt configured. The Run tests
// step row uses it for its overlap note: a hook that "runs the test suite and
// fixes issues" after every merge does the same job, so the two may run the
// tests twice. Read once per project; the hook is edited on the Task Board, so
// a stale answer only affects an informational note.
export function postMergeHookConfigured(settings: Pick<UserSettings, 'postMergeHookPrompt'>): boolean {
  return typeof settings.postMergeHookPrompt === 'string' && settings.postMergeHookPrompt.trim().length > 0;
}

export function usePostMergeHookConfigured(activeFolder: string): boolean {
  const [state, setState] = useState<{ folder: string; configured: boolean } | null>(null);
  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (!cancelled) setState({ folder: activeFolder, configured: postMergeHookConfigured(s) });
      })
      .catch(() => {
        /* informational only — leave the note off */
      });
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);
  // Never show another project's answer during a switch.
  return state?.folder === activeFolder ? state.configured : false;
}
