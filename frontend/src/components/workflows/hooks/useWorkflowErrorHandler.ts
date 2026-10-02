import { useAutoDismissMessage } from '../../shared/useAutoDismissMessage';

// Shared workflow-panel error state. Showing a new message replaces the old
// toast and auto-dismisses it after the same delay the launcher used before.
export function useWorkflowErrorHandler() {
  const {
    message: error,
    show: showError,
    clear: clearError,
  } = useAutoDismissMessage();

  return { error, showError, clearError };
}
