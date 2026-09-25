import { useCallback, useEffect, useRef, useState } from 'react';
import { previewProjectInit, type ProjectInitPreview } from '../../api';

// Debounce for the re-preview an edit to the .gitignore triggers. Long enough
// that a burst of typing is one request, short enough that the file count
// visibly reacts to the line just added — that feedback loop is the entire
// reason the textarea is editable, and the mitigation for committing a `.env`
// or a 2GB node_modules.
const PREVIEW_DEBOUNCE_MS = 400;

// The first-commit preview behind the Git Setup dialog: one initial POST of
// `/api/project-init/preview`, then a debounced re-POST on every user edit to
// the .gitignore draft. `error` is shared with the dialog's init action, which
// is why its setter is handed back too.
export function useInitPreview(project: string) {
  const [preview, setPreview] = useState<ProjectInitPreview | null>(null);
  // The .gitignore draft. Null until the first preview lands, so the textarea
  // never flashes empty and an early re-preview can't post "".
  const [gitignore, setGitignore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Until the user touches the textarea there is nothing to re-preview — the
  // draft is still byte-identical to what the backend just handed us.
  const edited = useRef(false);
  // Monotonic id so a slow re-preview can't land on top of a newer one and
  // resurrect a stale count.
  const previewSeq = useRef(0);

  const loadPreview = useCallback(
    async (draft: string | undefined, initial: boolean) => {
      const seq = (previewSeq.current += 1);
      if (initial) setLoading(true);
      else setRefreshing(true);
      try {
        const next = await previewProjectInit(project, draft);
        if (seq !== previewSeq.current) return;
        setPreview(next);
        setError(null);
        if (initial) setGitignore(next.gitignore);
      } catch (err) {
        if (seq !== previewSeq.current) return;
        setError((err as Error).message);
      } finally {
        if (seq === previewSeq.current) {
          if (initial) setLoading(false);
          else setRefreshing(false);
        }
      }
    },
    [project],
  );

  useEffect(() => {
    void loadPreview(undefined, true);
  }, [loadPreview]);

  useEffect(() => {
    if (gitignore === null || !edited.current) return;
    const timer = window.setTimeout(() => {
      void loadPreview(gitignore, false);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [gitignore, loadPreview]);

  // The textarea's change handler: marks the draft as user-edited so the
  // debounced re-preview above starts firing.
  const editGitignore = useCallback((next: string) => {
    edited.current = true;
    setGitignore(next);
  }, []);

  return { preview, gitignore, editGitignore, loading, refreshing, error, setError };
}
