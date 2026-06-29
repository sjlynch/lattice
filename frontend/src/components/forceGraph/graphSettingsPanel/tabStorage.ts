import { latticeStorageKeys, safeLocalStorageGetItem, safeLocalStorageSetItem } from '../../../storage/latticeLocalStorage';
import { DEFAULT_TAB, TABS, type TabKey } from './config';

function isTabKey(raw: string | null): raw is TabKey {
  return !!raw && TABS.some((t) => t.key === raw);
}

export function loadActiveGraphSettingsTab(project: string): TabKey {
  if (!project) return DEFAULT_TAB;
  const raw = safeLocalStorageGetItem(latticeStorageKeys.graphSettingsTab(project));
  return isTabKey(raw) ? raw : DEFAULT_TAB;
}

export function saveActiveGraphSettingsTab(project: string, tab: TabKey): void {
  if (!project) return;
  safeLocalStorageSetItem(latticeStorageKeys.graphSettingsTab(project), tab);
}
