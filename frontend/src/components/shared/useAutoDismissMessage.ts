import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a toast message stays up before it auto-dismisses. */
export const TOAST_DISMISS_MS = 5000;

// One auto-dismissing message slot (toast state). `show(msg)` replaces the
// current message and re-arms the timer; the timer only clears the slot if it
// still holds that same message, so a newer message (or one written through
// `setMessage`) is never wiped by an older timer. `clear()` drops the message
// and its pending timer; unmount clears the timer too. `show`/`clear` are
// referentially stable for a constant `dismissMs` (callers list them as effect
// dependencies).
export function useAutoDismissMessage(dismissMs: number = TOAST_DISMISS_MS) {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback(
    (msg: string) => {
      setMessage(msg);
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setMessage((cur) => (cur === msg ? null : cur));
      }, dismissMs);
    },
    [clearTimer, dismissMs],
  );

  const clear = useCallback(() => {
    setMessage(null);
    clearTimer();
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { message, setMessage, show, clear };
}
