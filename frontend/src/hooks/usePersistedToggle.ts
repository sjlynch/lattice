import { useCallback, useEffect, useState } from 'react';

function readPersistedToggle(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

function writePersistedToggle(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Ignore storage errors (private mode, quota, disabled storage).
  }
}

export function usePersistedToggle(
  key: string,
  defaultValue: boolean,
): [boolean, () => void] {
  const [value, setValue] = useState(() =>
    readPersistedToggle(key, defaultValue),
  );

  useEffect(() => {
    setValue(readPersistedToggle(key, defaultValue));
  }, [key, defaultValue]);

  useEffect(() => {
    writePersistedToggle(key, value);
  }, [key, value]);

  const toggle = useCallback(() => {
    setValue((current) => !current);
  }, []);

  return [value, toggle];
}
