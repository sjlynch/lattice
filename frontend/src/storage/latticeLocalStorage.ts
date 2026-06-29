// Shared localStorage helpers for Lattice's per-project browser state.
// Keep key builders here so call sites don't duplicate string prefixes and
// accidentally drift from the backwards-compatible persisted names.

export const latticeStorageKeys = {
  graphSettings: (project: string) => `lattice.graphSettings.${project}`,
  graphSettingsTab: (project: string) => `lattice.graphSettingsTab.${project}`,
  graphCamera: (project: string) => `lattice.graphCamera.${project}`,
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function safeLocalStorageGetItem(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeLocalStorageSetItem(key: string, value: string): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeLocalStorageRemoveItem(key: string): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
