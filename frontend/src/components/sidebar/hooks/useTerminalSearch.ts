import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

export function useTerminalSearch(panelTerminals: TerminalSpec[]) {
  const [filter, setFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const trimmedFilter = filter.trim().toLowerCase();
  const visibleTerminals = useMemo(() => {
    if (!trimmedFilter) return panelTerminals;
    return panelTerminals.filter((t) => {
      const haystack = `${t.label} ${t.cwd}`.toLowerCase();
      return haystack.includes(trimmedFilter);
    });
  }, [panelTerminals, trimmedFilter]);

  const toggle = useCallback(() => {
    setSearchOpen((open) => {
      const next = !open;
      if (!next) setFilter('');
      return next;
    });
  }, []);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setFilter('');
      setSearchOpen(false);
    }
  }, []);

  const reset = useCallback(() => {
    setFilter('');
    setSearchOpen(false);
  }, []);

  return {
    filter,
    searchOpen,
    searchInputRef,
    visibleTerminals,
    toggle,
    onKeyDown,
    setFilter,
    reset,
  };
}
