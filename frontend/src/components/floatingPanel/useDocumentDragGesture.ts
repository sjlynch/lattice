import { useCallback, useEffect, useRef } from 'react';

/**
 * Owns the document mousemove/mouseup listener lifecycle for a pointer drag
 * gesture. A gesture snapshot of type `TState` is captured by `start(state)`
 * and handed to `onMove` on every mousemove; `stop` (also bound to mouseup and
 * to unmount cleanup) drops the snapshot and detaches the listeners. Callers
 * supply only the per-move math via `onMove`.
 */
export function useDocumentDragGesture<TState>(
  onMove: (state: TState, event: MouseEvent) => void,
) {
  const stateRef = useRef<TState | null>(null);
  const removeListenersRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    stateRef.current = null;
    removeListenersRef.current?.();
    removeListenersRef.current = null;
  }, []);

  useEffect(() => {
    return stop;
  }, [stop]);

  const start = useCallback(
    (state: TState) => {
      stop();
      stateRef.current = state;

      function move(moveEvent: MouseEvent) {
        if (!stateRef.current) return;
        onMove(stateRef.current, moveEvent);
      }

      function up() {
        stop();
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      removeListenersRef.current = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
    },
    [onMove, stop],
  );

  return { start, stop };
}
