import { getPiModels } from './api';
import { createPiMenuStore } from './piMenuStoreCore';

export type {
  PiMenuFetcher,
  PiMenuListener,
  PiMenuStore,
} from './piMenuStoreCore';
export { createPiMenuStore } from './piMenuStoreCore';

// Shared cache for the curated "Pi — X" model menu (GET /api/pi-models `.menu`).
//
// The menu is machine-global, so every harness dropdown (task board, workflow
// steps, post-merge hook, sidebar new-terminal) wants the SAME list. Before this
// store each consumer fetched independently and could never learn that a
// Settings → Pi save changed the menu without a full page reload. The store
// gives them one cached list plus a refresh signal: `notifyPiModelsChanged()`
// refetches and notifies every mounted dropdown.
//
// `getPiModels` returns empty lists when `pi` isn't installed, so an empty menu
// just means "only bare Pi shows".
export const piMenuStore = createPiMenuStore(() => getPiModels().then((r) => r.menu));

// Call after a Settings → Pi save that changed providers or the curated menu, so
// every mounted harness dropdown refetches GET /api/pi-models without a reload.
export function notifyPiModelsChanged(): Promise<void> {
  return piMenuStore.refresh();
}
