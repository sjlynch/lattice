import { useEffect, useState } from 'react';
import { fetchUserSettingsStrict, type UserSettings } from '../../api';

const FIELDS = ['taskReview', 'taskReviewHarness', 'taskReviewModel', 'taskReviewEffort',
  'taskReviewRerunHarness', 'taskReviewRerunModel', 'taskReviewRerunPiModel', 'taskReviewRerunEffort'] as const;
type ReviewSettings = Pick<UserSettings, typeof FIELDS[number]>;

// Per-field edits survive a late GET; no loaded defaults ride an unrelated
// Save. Session cleanup fences project A -> B -> A and close/reopen races.
export function useTaskReviewDraft(open: boolean, activeFolder: string) {
  const [draft, setDraft] = useState<{ project: string; values: ReviewSettings; edits: ReviewSettings }>({
    project: '', values: {}, edits: {},
  });
  useEffect(() => {
    setDraft({ project: open ? activeFolder : '', values: {}, edits: {} });
    if (!open || !activeFolder) return;
    let cancelled = false;
    fetchUserSettingsStrict(activeFolder).then((settings) => {
      const values = Object.fromEntries(FIELDS.map((key) => [key, settings[key]])) as ReviewSettings;
      if (!cancelled) setDraft((current) => ({ ...current, values: { ...values, ...current.edits } }));
    }).catch(() => { /* untouched fields remain absent from Save */ });
    return () => { cancelled = true; };
  }, [open, activeFolder]);
  return {
    values: draft.values,
    set: (patch: ReviewSettings) => setDraft((current) => ({
      ...current, values: { ...current.values, ...patch }, edits: { ...current.edits, ...patch },
    })),
    getPatch: (): Partial<UserSettings> | undefined => {
      if (!open || !activeFolder || draft.project !== activeFolder || !Object.keys(draft.edits).length) return undefined;
      // JSON null clears an optional field; JSON undefined would be dropped
      // in transit and accidentally preserve its old persisted value.
      return Object.fromEntries(Object.entries(draft.edits).map(([key, value]) => [key, value ?? null]));
    },
  };
}
