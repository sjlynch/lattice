import { useCallback, useEffect, useRef, useState } from 'react';

// Shared workflow-panel error state. Showing a new message replaces the old
// toast and auto-dismisses it after the same delay the launcher used before.
export function useWorkflowErrorHandler() {
  const [error, setError] = useState<string | null>(null);
  const dismissTimerRef = useRef<number | null>(null);

  const clearError = useCallback(() => {
    setError(null);
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = window.setTimeout(() => {
      setError((cur) => (cur === msg ? null : cur));
      dismissTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    },
    [],
  );

  return { error, showError, clearError };
}
