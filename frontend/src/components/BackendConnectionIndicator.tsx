import { useEffect, useState } from 'react';
import { isBackendConnectionDown, subscribeBackendConnection } from '../api/ws';

// Only show after the live channels have been down this long, so a single
// socket blip (a slow-client reconnect, a sleep/wake) never flashes the pill.
export const BACKEND_DOWN_SHOW_DELAY_MS = 1500;

// Subtle navbar pill while the backend's live channels are down — in practice
// a backend restart (Lattice merging a backend change into itself). Purely
// informational: every live feed reconnects and re-syncs on its own, and the
// "start X" actions retry through the gap (`api/retry.ts`).
export function BackendConnectionIndicator() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = (down: boolean) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!down) {
        setVisible(false);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        setVisible(true);
      }, BACKEND_DOWN_SHOW_DELAY_MS);
    };
    apply(isBackendConnectionDown());
    const unsub = subscribeBackendConnection(apply);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;
  return (
    <span
      className="appbar-conn"
      role="status"
      title="Lost the live connection to the Lattice backend (usually a restart after a merge). Everything reconnects and re-syncs automatically; actions you start now are retried."
    >
      <span className="spinner appbar-conn-spinner" aria-hidden="true" />
      Backend restarting — reconnecting…
    </span>
  );
}
