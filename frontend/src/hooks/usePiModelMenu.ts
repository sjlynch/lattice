import { useEffect, useSyncExternalStore } from 'react';
import type { PiMenuEntry } from '../api';
import { piMenuStore } from '../piModelMenuStore';

// The curated "Pi — X" model menu, shared across every harness dropdown (task
// board, workflow steps/overrides, post-merge hook, sidebar new-terminal). Reads
// from the shared `piMenuStore` so all consumers see one cached list and refetch
// together when Settings → Pi saves call `notifyPiModelsChanged()`.
//
// Each consumer still owns its own selection/persistence; this only supplies the
// detected/curated menu data.
export function usePiModelMenu(): PiMenuEntry[] {
  const piMenu = useSyncExternalStore(piMenuStore.subscribe, piMenuStore.getMenu);
  useEffect(() => {
    void piMenuStore.ensure();
  }, []);
  return piMenu;
}
