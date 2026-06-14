import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Ctx, Persisted, TerminalSpec } from './terminal/terminalTypes';
import { loadPersisted, persist } from './terminal/terminalStorage';
import {
  addTerminalToList,
  newTerminalId,
  pickActiveAfterAdd,
  pickActiveAfterClose,
  pickActiveAfterCloseMany,
  pickInitialActiveId,
  removeTerminalFromList,
  removeTerminalsFromList,
  renameTerminalInList,
  reorderTerminalInList,
  setServerIdInList,
} from './terminal/terminalState';
import { deleteBackendSession } from './terminal/terminalApi';

export type { TerminalSpec };

const TerminalsContext = createContext<Ctx | null>(null);

export function TerminalsProvider({ children }: { children: ReactNode }) {
  // Initialize from sessionStorage so terminals persist across reloads in
  // this tab, but stay isolated from other tabs.
  const initial = useRef<Persisted | null>(null);
  if (initial.current === null) initial.current = loadPersisted();

  const [terminals, setTerminals] = useState<TerminalSpec[]>(
    initial.current.terminals,
  );
  const [activeId, setActiveIdState] = useState<string | null>(
    pickInitialActiveId(initial.current),
  );

  // Mirror state into a ref so callbacks can read the latest list without
  // making the side effect run inside a setState updater (React StrictMode
  // calls updaters twice in dev to detect impurities — a fetch in there
  // would fire twice and DELETE the pty session twice).
  const terminalsRef = useRef<TerminalSpec[]>(terminals);
  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  // Persist on every change.
  useEffect(() => {
    persist({ terminals, activeId });
  }, [terminals, activeId]);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
  }, []);

  const addTerminal = useCallback(
    (spec: Omit<TerminalSpec, 'id'>, focus = true): string => {
      const id = newTerminalId();
      setTerminals((ts) => addTerminalToList(ts, spec, id));
      setActiveIdState((current) => pickActiveAfterAdd(current, id, focus));
      return id;
    },
    [],
  );

  const closeTerminal = useCallback((id: string) => {
    // Read the current spec from a ref BEFORE calling setState. The DELETE
    // is a side effect; in StrictMode the setState updater would run
    // twice, which previously fired two DELETEs in <100ms — node-pty's
    // Windows cleanup path then tripped over its own helper subprocess
    // crashing and brought the whole backend down.
    const prev = terminalsRef.current;
    const target = prev.find((t) => t.id === id);
    if (!target) {
      console.warn('[lattice] closeTerminal called with unknown id', id);
      return;
    }
    console.log('[lattice] closeTerminal', {
      localId: target.id,
      serverId: target.serverId ?? '(none)',
      label: target.label,
      cwd: target.cwd,
    });
    if (target.serverId) deleteBackendSession(target.serverId);
    const next = removeTerminalFromList(prev, id);
    setTerminals(next);
    setActiveIdState((current) =>
      pickActiveAfterClose(prev, next, id, current),
    );
  }, []);

  const setServerId = useCallback((id: string, serverId: string) => {
    setTerminals((ts) => setServerIdInList(ts, id, serverId));
  }, []);

  // Rename a tab's label. Purely a UI label change — the new name is
  // persisted to sessionStorage like any other spec field and feeds the
  // sidebar search haystack. Empty/whitespace names are ignored so a tab
  // can never become unlabelled.
  const renameTerminal = useCallback((id: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setTerminals((ts) => renameTerminalInList(ts, id, trimmed));
  }, []);

  const reorderTerminal = useCallback((draggedId: string, targetId: string) => {
    setTerminals((ts) => reorderTerminalInList(ts, draggedId, targetId));
  }, []);

  const closeTerminals = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    const prev = terminalsRef.current;
    for (const id of ids) {
      const target = prev.find((t) => t.id === id);
      if (target?.serverId) deleteBackendSession(target.serverId);
    }
    const next = removeTerminalsFromList(prev, idSet);
    setTerminals(next);
    setActiveIdState((current) =>
      pickActiveAfterCloseMany(prev, next, idSet, current),
    );
  }, []);

  const closeTerminalsForTask = useCallback(
    (taskId: string) => {
      const targets = terminalsRef.current
        .filter((t) => t.taskId === taskId)
        .map((t) => t.id);
      for (const id of targets) {
        closeTerminal(id);
      }
    },
    [closeTerminal],
  );

  // Memoize the context value so its identity is stable across renders that
  // don't change terminals/activeId. The callbacks are already useCallback-
  // stable, so this recomputes only when terminals or activeId actually
  // change — exactly when consumers must re-render. Without this, the
  // freshly-allocated object literal re-rendered every useTerminals()
  // consumer on any provider render.
  const value = useMemo<Ctx>(
    () => ({
      terminals,
      activeId,
      setActiveId,
      addTerminal,
      closeTerminal,
      closeTerminals,
      closeTerminalsForTask,
      setServerId,
      renameTerminal,
      reorderTerminal,
    }),
    [
      terminals,
      activeId,
      setActiveId,
      addTerminal,
      closeTerminal,
      closeTerminals,
      closeTerminalsForTask,
      setServerId,
      renameTerminal,
      reorderTerminal,
    ],
  );

  return (
    <TerminalsContext.Provider value={value}>
      {children}
    </TerminalsContext.Provider>
  );
}

export function useTerminals(): Ctx {
  const ctx = useContext(TerminalsContext);
  if (!ctx) throw new Error('TerminalsProvider missing');
  return ctx;
}
