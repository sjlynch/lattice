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
import type { Ctx, Persisted, TerminalSpec, TerminalStatus } from './terminal/terminalTypes';
import { loadPersisted, persist } from './terminal/terminalStorage';
import {
  addTerminalToList,
  newTerminalId,
  pickActiveAfterAdd,
  pickActiveAfterClose,
  pickActiveAfterCloseMany,
  pickInitialActiveId,
  planCloseTerminals,
  removeTerminalFromList,
  removeTerminalsFromList,
  renameTerminalInList,
  reorderTerminalInList,
  setServerIdInList,
  setStatusInList,
  terminalIdsForTask,
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
    // Remove functionally so a close batched with sibling closes in one React
    // tick composes onto the latest list, instead of the last setState — built
    // from this same pre-batch snapshot minus just its own id — clobbering the
    // earlier removals. The DELETE + active-id fallback still derive from `prev`
    // once, outside the updater (StrictMode double-invokes updaters, so a DELETE
    // in there would fire twice).
    const next = removeTerminalFromList(prev, id);
    setTerminals((current) => removeTerminalFromList(current, id));
    setActiveIdState((current) =>
      pickActiveAfterClose(prev, next, id, current),
    );
  }, []);

  const setServerId = useCallback((id: string, serverId: string) => {
    setTerminals((ts) => setServerIdInList(ts, id, serverId));
  }, []);

  // Reflect the connection hook's transitions onto the tab model so the
  // sidebar can show a health indicator. Pure state update (no IO); the
  // setStatusInList no-op guard keeps repeated `live` reports from re-rendering
  // the tab strip.
  const setStatus = useCallback(
    (id: string, status: TerminalStatus, exitCode?: number) => {
      setTerminals((ts) => setStatusInList(ts, id, status, exitCode));
    },
    [],
  );

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
    const { serverIdsToDelete, next } = planCloseTerminals(prev, idSet);
    for (const serverId of serverIdsToDelete) deleteBackendSession(serverId);
    // Apply the removal functionally. useTaskTerminalCleanup fires
    // closeTerminalsForTask (→ closeTerminals) once PER finalizing task in a
    // synchronous loop, and every call reads the SAME pre-batch terminalsRef
    // (it only re-syncs in the [terminals] effect, never mid-batch). A direct
    // setTerminals(next) meant React kept only the LAST call's result — that
    // snapshot minus just its own task's ids — so every other finalizing task's
    // terminals were resurrected as dead 'session lost' tabs (their backend
    // sessions had already been DELETEd). Removing off the live `current` list
    // makes the calls compose. The DELETE set + active-id fallback still come
    // from the single `prev` snapshot (disjoint per task, and kept out of the
    // StrictMode-double-invoked updater).
    setTerminals((current) => removeTerminalsFromList(current, idSet));
    setActiveIdState((current) =>
      pickActiveAfterCloseMany(prev, next, idSet, current),
    );
  }, []);

  // Delegate to the batched closeTerminals so every terminal for the task is
  // removed in ONE setState. Looping closeTerminal(id) instead re-read the
  // stale terminalsRef per id (the ref only syncs in an effect after render),
  // so the last setState — computed from the pre-loop snapshot minus just its
  // own id — clobbered the earlier removals and resurrected the sibling tabs.
  // closeTerminals now also removes functionally, so even several
  // closeTerminalsForTask calls batched in one update (multiple tasks finalizing
  // at once — a Merge All, a multi-select delete) compose instead of the last
  // one clobbering the rest.
  const closeTerminalsForTask = useCallback(
    (taskId: string) => {
      const ids = terminalIdsForTask(terminalsRef.current, taskId);
      if (ids.length > 0) closeTerminals(ids);
    },
    [closeTerminals],
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
      setStatus,
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
      setStatus,
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
