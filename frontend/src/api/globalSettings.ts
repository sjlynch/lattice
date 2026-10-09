// Machine-global settings (not per-project). Backend: src/globalSettings.ts.

import { asJson, patchJson } from './http';
import type { GlobalSettings } from '../../../backend/src/shared/wireTypes';

// The backend's own types (backend/src/globalSettings/types.ts and, for the
// Pi providers, backend/src/piModels/types.ts), re-exported through
// backend/src/shared/wireTypes.ts. Add a field THERE.
export type {
  GlobalSettings,
  PiProvider,
  PiProviderModel,
} from '../../../backend/src/shared/wireTypes';

export async function fetchGlobalSettings(): Promise<GlobalSettings> {
  return asJson<GlobalSettings>(await fetch('/api/global-settings'));
}

export async function patchGlobalSettings(
  patch: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  return patchJson<GlobalSettings>('/api/global-settings', patch);
}
