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
  RestoreNotice,
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
import { deleteBackendSession, fetchLiveTerminalIds } from './terminal/terminalApi';
import {
  applyTerminalTabsEvent,
  mergeRegistryTabs,
  registeredOrder,
  restorableCount,
} from './terminal/terminalRegistrySync';
import {
  closeTerminalTab,
  fetchTerminalTabs,
  patchTerminalTabLabel,
  patchTerminalTabOrder,
  restoreTerminalTabs,
  subscribeTerminalTabs,
} from './api/terminalTabs';
import type { RestoreSummary, RestoreTerminalsMode, TerminalRecord } from './api/types/terminalTabs';

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
const REGISTRY_FETCH_ATTEMPTS = 4;
const REGISTRY_FETCH_RETRY_MS = 750;

// A pure re-attach of live tabs happens on every reload and is not worth a
// notice; relaunches, drops and failures are.
// `already-running` counts too: it is the only feedback the button can give
// while a previous pass's relaunches are still queued behind the cap.
function isNoteworthy(summary: RestoreSummary): boolean {
  if (summary.status !== 'ok') return true;
  return summary.queued > 0 || summary.dropped.length > 0;
}


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
  const [lastRestore, setLastRestore] = useState<RestoreNotice | null>(null);
  const [restorePrompt, setRestorePrompt] = useState<{ count: number } | null>(null);

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

  // Projects this page session has already auto-restored, so a settings
  // refetch or a re-render never fires a second automatic pass.
  const autoRestoredRef = useRef<Set<string>>(new Set());
  // One silent pass in flight PER PROJECT. Keyed by folder (a single global
  // slot used to hand project B's on-open pass project A's still-running
  // promise, so B was marked auto-restored without ever being restored). An
  // explicit "Restore tabs" click always goes through: the backend answers
  // `already-running` if a pass is still busy, and that is the feedback the
  // button owes the user.
  const restoreInFlightRef = useRef<Map<string, Promise<RestoreSummary | null>>>(new Map());

  const runRestore = useCallback(async (opts: { retry?: boolean } = {}): Promise<RestoreSummary | null> => {
    const folder = activeFolderRef.current;
    if (!folder) return null;
    const inFlight = restoreInFlightRef.current.get(folder);
    if (inFlight && !opts.retry) return inFlight;
    let run: Promise<RestoreSummary | null> | null = null;
    run = (async () => {
      try {
        const summary = await restoreTerminalTabs(folder, opts);
        if (activeFolderRef.current === folder) setRestorePrompt(null);
        // The HTTP response is the authoritative summary for a restore THIS
        // tab asked for: the matching WS `restore-summary` can fire before
        // the socket is even open on a fresh page load. The WS event still
        // covers restores triggered from another browser tab.
        // A silent on-open pass colliding with an in-progress one stays silent;
        // an explicit click deserves the "already in progress" line.
        if (isNoteworthy(summary) && (summary.status !== 'already-running' || opts.retry)) {
          setLastRestore({ projectPath: folder, summary, at: Date.now() });
        }
        // Tabs being relaunched: flag them "restored" now and drop the dead
        // pty id, so no pane attaches to it while the relaunch is in flight.
        // The registry's own upsert/restored events (or the next `hello`)
        // deliver the new pty id.
        const relaunched = new Set(summary.relaunchedIds ?? []);
        if (relaunched.size > 0) {
          setTerminals((ts) =>
            ts.map((t) =>
              relaunched.has(t.id) && t.registered
                ? { ...t, restored: true, ...(t.serverId ? { serverId: undefined, restore: 'pending' as const } : {}) }
                : t,
            ),
          );
        }
        return summary;
      } catch (err) {
        console.warn('[lattice] terminal restore failed:', err);
        return null;
      } finally {
        if (run && restoreInFlightRef.current.get(folder) === run) restoreInFlightRef.current.delete(folder);
      }
    })();
    if (!opts.retry) restoreInFlightRef.current.set(folder, run);
    return run;
  }, []);

  // The registry's records for the open project, stamped with the folder they
  // came from. The auto-restore decision keys on THIS (plus the setting), not
  // on the subscription effect, so the setting arriving a moment after the
  // folder (restoreMode null → value) never tears the socket down or refetches.
  const [registryLoaded, setRegistryLoaded] = useState<{
    folder: string;
    records: TerminalRecord[];
  } | null>(null);

  // Ids of registered tabs added (addTerminal) while the project's registry
  // fetch is in flight. The fetch's answer predates them, so a plain merge
  // would drop them as "not in the registry"; they are kept explicitly.
  const addedDuringFetchRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    setRestorePrompt(null);
    if (!activeFolder) return;
    let cancelled = false;
    const unsub = subscribeTerminalTabs(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type === 'hello') {
        setTerminals((ts) => mergeRegistryTabs(ts, ev.tabs, activeFolder, addedDuringFetchRef.current));
        // The socket's snapshot is as good as the HTTP answer for gating the
        // auto-restore — a slow or failed fetch must not leave every pending
        // tab unmountable with no restore ever fired.
        setRegistryLoaded((cur) => (cur && cur.folder === activeFolder ? cur : { folder: activeFolder, records: ev.tabs }));
        return;
      }
      if (ev.type === 'restore-summary') {
        if (isNoteworthy(ev.summary)) {
          setLastRestore({ projectPath: activeFolder, summary: ev.summary, at: Date.now() });
        }
        return;
      }
      setTerminals((ts) => applyTerminalTabsEvent(ts, ev));
    });
    // The HTTP fetch is what gates the auto-restore: it settles even when the
    // WS is slow to connect, and its result tells 'ask' mode how many tabs
    // are on offer.
    const added = new Set<string>();
    addedDuringFetchRef.current = added;
    // A backend still booting (the dev runner restarting it under the page)
    // fails the first fetch; retry a few times before leaving it to the WS
    // `hello` above.
    const attempt = (n: number): void => {
      void fetchTerminalTabs(activeFolder)
        .then((records) => {
          if (cancelled) return;
          setTerminals((ts) => mergeRegistryTabs(ts, records, activeFolder, added));
          setRegistryLoaded((cur) => (cur && cur.folder === activeFolder ? cur : { folder: activeFolder, records }));
          if (addedDuringFetchRef.current === added) addedDuringFetchRef.current = null;
        })
        .catch((err) => {
          if (cancelled) return;
          if (n < REGISTRY_FETCH_ATTEMPTS) {
            setTimeout(() => { if (!cancelled) attempt(n + 1); }, REGISTRY_FETCH_RETRY_MS * n);
            return;
          }
          console.warn('[lattice] terminal registry fetch failed:', err);
          if (addedDuringFetchRef.current === added) addedDuringFetchRef.current = null;
        });
    };
    attempt(1);
    return () => {
      cancelled = true;
      if (addedDuringFetchRef.current === added) addedDuringFetchRef.current = null;
      unsub();
    };
  }, [activeFolder]);

  // Auto-restore — once per project per page session — as soon as both the
  // project's records and its restore setting are known.
  useEffect(() => {
    if (!activeFolder || restoreMode === null) return;
    if (!registryLoaded || registryLoaded.folder !== activeFolder) return;
    if (autoRestoredRef.current.has(activeFolder)) return;
    if (restoreMode === 'always') {
      autoRestoredRef.current.add(activeFolder);
      void runRestore();
      return;
    }
    if (restoreMode !== 'ask') return;
    // Only ask when something would actually be relaunched. Tabs whose pty is
    // still alive re-attach by themselves, and restoring them is a harmless
    // adopt — so with nothing dead, run that silently. The folder is marked
    // done only once we act: a fetch cancelled by a project switch must leave
    // it eligible for the next visit.
    let cancelled = false;
    void fetchLiveTerminalIds().then((live) => {
      if (cancelled) return;
      autoRestoredRef.current.add(activeFolder);
      const count = restorableCount(registryLoaded.records, live);
      if (count > 0) setRestorePrompt({ count });
      else void runRestore();
    });
    return () => {
      cancelled = true;
    };
  }, [activeFolder, restoreMode, registryLoaded, runRestore]);

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
    [],
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

  const dismissRestoreNotice = useCallback(() => setLastRestore(null), []);

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
