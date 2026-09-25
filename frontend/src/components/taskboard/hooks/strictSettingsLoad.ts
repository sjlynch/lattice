import { fetchUserSettingsStrict, type UserSettings } from '../../../api';
import { retryDelay } from '../../../hooks/scanRetry';

// Load `folder`'s userSettings STRICTLY, retrying a failure with the scan-style
// backoff until it succeeds or the returned cancel thunk is called (an effect
// cleanup — project switch / unmount). `onLoaded` fires once, with a real
// answer only.
//
// The lenient `fetchUserSettings` maps any failure — routinely a 502 from the
// Vite proxy while the backend restarts — to `{}`. A hook that took that as its
// loaded state showed defaults for the whole session, and the next toggle
// PATCHed those defaults over the saved value (the QA-lane Playwright Globe
// flipping a saved headed mode to headless). Same contract as `useUserSettings`.
export function loadUserSettingsWithRetry(
  folder: string,
  onLoaded: (settings: UserSettings) => void,
  label: string,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const attempt = (n: number): void => {
    fetchUserSettingsStrict(folder).then(
      (settings) => {
        if (!cancelled) onLoaded(settings);
      },
      // Second `then` arg, not `.catch`: an exception thrown by `onLoaded`
      // must surface, not be mistaken for a failed fetch and retried.
      (err: unknown) => {
        if (cancelled) return;
        if (n === 0) console.warn(`[lattice] ${label} settings load failed, retrying:`, err);
        timer = setTimeout(() => {
          timer = null;
          if (!cancelled) attempt(n + 1);
        }, retryDelay(n));
      },
    );
  };
  attempt(0);

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
