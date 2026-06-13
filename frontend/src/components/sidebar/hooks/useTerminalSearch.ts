import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

export function useTerminalSearch(panelTerminals: TerminalSpec[]) {
  const [filter, setFilter] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const trimmedFilter = filter.trim().toLowerCase();
  const visibleTerminals = useMemo(() => {
    if (!trimmedFilter) return panelTerminals;
    return panelTerminals.filter((t) => {
      // `label` doubles as the searchable session name — tabs can be
      // renamed (double-click) to a memorable name, and `cwd` lets the
      // user find a session by its working directory.
      const haystack = `${t.label} ${t.cwd}`.toLowerCase();
      return haystack.includes(trimmedFilter);
    });
  }, [panelTerminals, trimmedFilter]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setFilter('');
      e.currentTarget.blur();
    }
  }, []);

  const reset = useCallback(() => setFilter(''), []);

  return {
    filter,
    searchInputRef,
    visibleTerminals,
    onKeyDown,
    setFilter,
    reset,
  };
}
