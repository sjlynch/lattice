// Per-project user settings (sidebar width, harness preference).

import { asJson } from './http';
import type { HarnessAvailability, UserSettings } from './types';

export async function fetchHarnessAvailability(): Promise<HarnessAvailability> {
  try {
    const r = await fetch('/api/harnesses');
    if (!r.ok) return { claude: true, pi: false };
    return r.json();
  } catch {
    return { claude: true, pi: false };
  }
}

export async function fetchUserSettings(projectPath: string): Promise<UserSettings> {
  try {
    const r = await fetch(`/api/settings?project=${encodeURIComponent(projectPath)}`);
    if (!r.ok) return {};
    return r.json();
  } catch {
    return {};
  }
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  return asJson<UserSettings>(
    await fetch(`/api/settings?project=${encodeURIComponent(projectPath)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }),
  );
}
