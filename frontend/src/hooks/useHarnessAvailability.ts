import { useEffect, useState } from 'react';
import { subscribeHarnesses, type HarnessAvailability } from '../api';

// Live harness-availability ({claude, pi, codex}) shared by every feature that
// renders a harness dropdown. The backend pushes the map once its CLI probe
// resolves and on every WS reconnect, so the UI catches up even when the page
// loaded before the server was listening.
//
// `harnessAvailLoaded` flips true on the first push — callers that coerce a
// saved-but-unavailable harness back to `claude` must wait for it, otherwise a
// slow-booting server would let them clobber a valid `pi`/`codex` preference.
export function useHarnessAvailability(): {
  harnessAvail: HarnessAvailability;
  harnessAvailLoaded: boolean;
} {
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });
  const [harnessAvailLoaded, setHarnessAvailLoaded] = useState(false);

  useEffect(() => {
    const unsub = subscribeHarnesses((avail) => {
      setHarnessAvail(avail);
      setHarnessAvailLoaded(true);
    });
    return unsub;
  }, []);

  return { harnessAvail, harnessAvailLoaded };
}
