import { useEffect, useRef } from 'react';
import { isTextInput } from './refresh';

// Centralizes the global keydown/keyup/blur/visibilitychange chord lifecycle
// shared by every hold-key graph overlay (H/Z/D/W/Alt). Each overlay used to
// re-add the same four listeners and the same `isTextInput` keydown guard, then
// wire blur + visibilitychange to the same reset — so a held chord can't get
// stuck "on" when the user alt-tabs or hides the tab.
//
// The handlers are read through a ref so the four window/document listeners
// register exactly once and never churn when a caller's closures change
// identity. `isTextInput` is applied to keydown for all callers (every overlay
// guards it first); keyup is passed through untouched. Set `resetOnUnmount` so
// the overlay also tears its side effects down when the hook unmounts (the `W`
// worktree highlight needs this — it has live rings to strip).
export type HoldKeyMode = {
  // Fired on keydown, after the shared text-input guard.
  onKeyDown(e: KeyboardEvent): void;
  // Fired on keyup.
  onKeyUp(e: KeyboardEvent): void;
  // Fired on window blur + document visibilitychange (chord reset), and on
  // unmount when `resetOnUnmount` is set.
  onReset(): void;
  resetOnUnmount?: boolean;
};

export function useHoldKeyMode(mode: HoldKeyMode): void {
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTextInput(e.target)) return;
      modeRef.current.onKeyDown(e);
    }
    function onKeyUp(e: KeyboardEvent) {
      modeRef.current.onKeyUp(e);
    }
    function reset() {
      modeRef.current.onReset();
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
      if (modeRef.current.resetOnUnmount) modeRef.current.onReset();
    };
  }, []);
}

// Build the chord handlers for a momentary single-letter hold overlay
// (H/Z/D/W): activate while the un-modified letter is held; deactivate on its
// keyup, on blur, and on tab-hide. ctrl/meta/alt-modified presses and key
// auto-repeat are ignored so the overlay only toggles on a deliberate tap-hold.
// `setActive(true/false)` carries each overlay's custom activation/deactivation
// side effects (a `setState`, an external setter, or a fetch/strip pair).
export function momentaryLetterMode(
  key: string,
  setActive: (active: boolean) => void,
  opts?: { resetOnUnmount?: boolean },
): HoldKeyMode {
  const lower = key.toLowerCase();
  const upper = key.toUpperCase();
  return {
    onKeyDown(e) {
      if (e.key !== lower && e.key !== upper) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat) return;
      setActive(true);
    },
    onKeyUp(e) {
      if (e.key === lower || e.key === upper) setActive(false);
    },
    onReset() {
      setActive(false);
    },
    resetOnUnmount: opts?.resetOnUnmount,
  };
}
