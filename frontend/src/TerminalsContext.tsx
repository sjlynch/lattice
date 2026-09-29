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
import type {
  AddTerminalSpec,
  Ctx,
  Persisted,
  TerminalSpec,
  TerminalStatus,
} from './terminal/terminalTypes';
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
  type KeepTerminal,
} from './terminal/terminalState';
import { deleteBackendSession } from './terminal/terminalApi';
import { registeredOrder } from './terminal/terminalRegistrySync';
import { useTerminalRegistrySync } from './terminal/useTerminalRegistrySync';
import {
  closeTerminalTab,
  patchTerminalTabLabel,
  patchTerminalTabOrder,
} from './api/terminalTabs';
import type { RestoreTerminalsMode } from './api/types/terminalTabs';

export type { TerminalSpec };

const TerminalsContext = createContext<Ctx | null>(null);

type ProviderProps = {
  children: ReactNode;
  // The open project. Drives the registry fetch / subscription and the
  // on-open restore.
  activeFolder: string;
  // The project's `restoreTerminalsOnOpen` setting, or null while its
  // settings are still loading (no auto-restore fires until it is known).
  restoreMode: RestoreTerminalsMode | null;
};

const ORDER_PATCH_DEBOUNCE_MS = 300;

export function TerminalsProvider({ children, activeFolder, restoreMode }: ProviderProps) {
  // Initialize from sessionStorage so terminals persist across reloads in
  // this tab, but stay isolated from other tabs. The backend registry
  // (fetched below) is the durable truth for registered tabs; this is only a
  // cache that lets the sidebar paint before the fetch lands.
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
  const activeFolderRef = useRef(activeFolder);
  useEffect(() => {
    activeFolderRef.current = activeFolder;
  }, [activeFolder]);

  // Persist on every change.
  useEffect(() => {
    persist({ terminals, activeId });
  }, [terminals, activeId]);

  // ---- registry: fetch on project open + live subscription ---------------

  // Called here, between the persist effect and the order-patch effects, so
  // the effects keep running in the same order they always have.
  const {
    runRestore,
    lastRestore,
    setLastRestore,
    restorePrompt,
    addedDuringFetchRef,
  } = useTerminalRegistrySync({ activeFolder, restoreMode, setTerminals, terminalsRef, activeFolderRef });

  // ---- decorations → registry -------------------------------------------

  const orderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePatchOrder = useCallback((list: TerminalSpec[]) => {
    const folder = activeFolderRef.current;
    if (!folder) return;
    const order = registeredOrder(list, folder);
    if (orderTimerRef.current) clearTimeout(orderTimerRef.current);
    orderTimerRef.current = setTimeout(() => {
      orderTimerRef.current = null;
      void patchTerminalTabOrder(folder, order).catch(() => {});
    }, ORDER_PATCH_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => {
    if (orderTimerRef.current) clearTimeout(orderTimerRef.current);
  }, []);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    // Activating a restored tab clears its "restored" marker.
    if (id) {
      setTerminals((ts) =>
        ts.some((t) => t.id === id && t.restored)
          ? ts.map((t) => (t.id === id ? { ...t, restored: undefined } : t))
          : ts,
      );
    }
  }, []);

  const addTerminal = useCallback(
    (spec: AddTerminalSpec, focus = true): string => {
      const id = spec.id ?? newTerminalId();
      const registered = spec.registered ?? spec.id !== undefined;
      const { id: _ignored, ...rest } = spec;
      if (registered) addedDuringFetchRef.current?.add(id);
      setTerminals((ts) => {
        // A registry `upsert` for a backend-minted id can land before the
        // caller's addTerminal: merge onto it instead of duplicating.
        const idx = ts.findIndex((t) => t.id === id);
        if (idx >= 0) {
          const next = [...ts];
          next[idx] = { ...ts[idx]!, ...rest, id, registered };
          return next;
        }
        return addTerminalToList(ts, { ...rest, registered }, id);
      });
      setActiveIdState((current) => pickActiveAfterAdd(current, id, focus));
      return id;
    },
    [addedDuringFetchRef],
  );

  // Tear down a tab's backend side: a registered tab closes through the
  // registry (which ends the record AND kills the pty); an unregistered one
  // just kills its pty.
  const closeBackend = useCallback((t: TerminalSpec) => {
    if (t.registered) {
      closeTerminalTab(t.projectPath ?? activeFolderRef.current, t.id);
    } else if (t.serverId) {
      deleteBackendSession(t.serverId);
    }
  }, []);

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
    closeBackend(target);
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
  }, [closeBackend]);

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

  // Rename a tab's label. Persisted to the registry for a registered tab so
  // the name survives a reload / restore; empty names are ignored so a tab
  // can never become unlabelled.
  const renameTerminal = useCallback((id: string, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const target = terminalsRef.current.find((t) => t.id === id);
    setTerminals((ts) => renameTerminalInList(ts, id, trimmed));
    if (target?.registered) {
      void patchTerminalTabLabel(target.projectPath ?? activeFolderRef.current, id, trimmed)
        .catch(() => {});
    }
  }, []);

  const reorderTerminal = useCallback((draggedId: string, targetId: string) => {
    const next = reorderTerminalInList(terminalsRef.current, draggedId, targetId);
    if (next === terminalsRef.current) return;
    setTerminals((ts) => reorderTerminalInList(ts, draggedId, targetId));
    schedulePatchOrder(next);
  }, [schedulePatchOrder]);

  const closeTerminals = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    const prev = terminalsRef.current;
    const { next } = planCloseTerminals(prev, idSet);
    // One backend teardown per tab (registered → registry DELETE, else the
    // pty DELETE); `seen` dedupes a repeated id.
    const seen = new Set<string>();
    for (const t of prev) {
      if (!idSet.has(t.id) || seen.has(t.id)) continue;
      seen.add(t.id);
      closeBackend(t);
    }
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
  }, [closeBackend]);

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
    (taskId: string, keep?: KeepTerminal) => {
      const ids = terminalIdsForTask(terminalsRef.current, taskId, keep);
      if (ids.length > 0) closeTerminals(ids);
    },
    [closeTerminals],
  );

  const dismissRestoreNotice = useCallback(() => setLastRestore(null), [setLastRestore]);

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
      restoreTabs: runRestore,
      lastRestore,
      dismissRestoreNotice,
      restorePrompt,
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
      runRestore,
      lastRestore,
      dismissRestoreNotice,
      restorePrompt,
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
