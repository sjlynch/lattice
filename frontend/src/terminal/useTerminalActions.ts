import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { AddTerminalSpec, Ctx, TerminalSpec, TerminalStatus } from './terminalTypes';
import {
  addTerminalToList,
  newTerminalId,
  pickActiveAfterAdd,
  pickActiveAfterClose,
  pickActiveAfterCloseMany,
  planCloseTerminals,
  removeTerminalFromList,
  removeTerminalsFromList,
  renameTerminalInList,
  reorderTerminalInList,
  setServerIdInList,
  setStatusInList,
  terminalIdsForTask,
  type KeepTerminal,
} from './terminalState';
import { deleteBackendSession } from './terminalApi';
import { registeredOrder } from './terminalRegistrySync';
import { closeTerminalTab, patchTerminalTabLabel, patchTerminalTabOrder } from '../api/terminalTabs';

type TerminalActions = Pick<Ctx,
  'setActiveId' | 'addTerminal' | 'closeTerminal' | 'closeTerminals' |
  'closeTerminalsForTask' | 'setServerId' | 'setStatus' | 'renameTerminal' | 'reorderTerminal'
>;

type UseTerminalActionsArgs = {
  setTerminals: Dispatch<SetStateAction<TerminalSpec[]>>;
  setActiveIdState: Dispatch<SetStateAction<string | null>>;
  terminalsRef: RefObject<TerminalSpec[]>;
  activeFolderRef: RefObject<string>;
  addedDuringFetchRef: RefObject<Set<string> | null>;
};

const ORDER_PATCH_DEBOUNCE_MS = 300;

// Commands and their IO live here; the provider owns state and persistence.
export function useTerminalActions({
  setTerminals, setActiveIdState, terminalsRef, activeFolderRef, addedDuringFetchRef,
}: UseTerminalActionsArgs): TerminalActions {
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

  // Unregistered tabs keep their immediate-close behavior. Registered tabs
  // stay visible until confirmation, with one request per id in flight.
  const closesInFlightRef = useRef(new Map<string, Promise<boolean>>());
  useEffect(() => {
    // sessionStorage can contain an in-flight close from the previous page.
    // Its request is no longer observable here; offer retry instead of leaving
    // the close button disabled indefinitely after a reload.
    const orphaned = new Set(terminalsRef.current
      .filter((t) => t.closeState === 'closing' && !closesInFlightRef.current.has(t.id))
      .map((t) => t.id));
    if (orphaned.size === 0) return;
    setTerminals((ts) => ts.map((t) => orphaned.has(t.id) && t.closeState === 'closing'
      ? { ...t, closeState: 'failed', closeError: 'Terminal close is unconfirmed. Retry closing this tab.' } : t));
  }, []);
  const closeBackend = useCallback((t: TerminalSpec): Promise<boolean> | null => {
    if (!t.registered) {
      if (t.serverId) deleteBackendSession(t.serverId);
      return null;
    }
    const existing = closesInFlightRef.current.get(t.id);
    if (existing) return existing;
    const project = t.projectPath ?? activeFolderRef.current;
    setTerminals((ts) => ts.map((tab) => tab.id === t.id
      ? { ...tab, closeState: 'closing', closeError: undefined } : tab));
    const closing = new Promise<boolean>((resolve) => {
      closeTerminalTab(project, t.id, {
        onClosed: () => resolve(true),
        onError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[lattice] terminal close failed:', error);
          setTerminals((ts) => ts.map((tab) => tab.id === t.id
            ? { ...tab, closeState: 'failed', closeError: message } : tab));
          resolve(false);
        },
      });
    }).finally(() => {
      if (closesInFlightRef.current.get(t.id) === closing) closesInFlightRef.current.delete(t.id);
    });
    closesInFlightRef.current.set(t.id, closing);
    return closing;
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
    // The first command already owns confirmation/removal. Repeated commands
    // must not accumulate continuations on the same pending request.
    if (closesInFlightRef.current.has(id)) return;
    console.log('[lattice] closeTerminal', {
      localId: target.id,
      serverId: target.serverId ?? '(none)',
      label: target.label,
      cwd: target.cwd,
    });
    const closing = closeBackend(target);
    // Remove functionally so a close batched with sibling closes in one React
    // tick composes onto the latest list, instead of the last setState — built
    // from this same pre-batch snapshot minus just its own id — clobbering the
    // earlier removals. The DELETE + active-id fallback still derive from `prev`
    // once, outside the updater (StrictMode double-invokes updaters, so a DELETE
    // in there would fire twice).
    const next = removeTerminalFromList(prev, id);
    const remove = () => {
      if (terminalsRef.current.some((t) => t.id === id)) {
        setTerminals((current) => removeTerminalFromList(current, id));
      }
      // A registry event may already have removed the tab; confirmation still
      // needs to move selection away from its id.
      setActiveIdState((current) => pickActiveAfterClose(prev, next, id, current));
    };
    if (closing) void closing.then((confirmed) => { if (confirmed) remove(); });
    else remove();
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
    if (idSet.size === 0) return;
    const prev = terminalsRef.current;
    // Deduplicate before IO. Keep the pre-update snapshot for fallback,
    // and remove functionally so concurrent task finalizations compose.
    const seen = new Set<string>();
    const immediate = new Set<string>();
    const pending: Promise<string | null>[] = [];
    for (const t of prev) {
      if (!idSet.has(t.id) || seen.has(t.id)) continue;
      seen.add(t.id);
      if (closesInFlightRef.current.has(t.id)) continue;
      const closing = closeBackend(t);
      if (closing) {
        pending.push(closing.then((confirmed) => confirmed ? t.id : null));
      } else immediate.add(t.id);
    }
    const remove = (closed: Set<string>) => {
      if (closed.size === 0) return;
      const { next } = planCloseTerminals(prev, closed);
      if (terminalsRef.current.some((t) => closed.has(t.id))) {
        setTerminals((current) => removeTerminalsFromList(current, closed));
      }
      setActiveIdState((current) => pickActiveAfterCloseMany(prev, next, closed, current));
    };
    remove(immediate);
    if (pending.length > 0) {
      void Promise.all(pending).then((confirmed) => {
        const confirmedIds = confirmed.filter((id): id is string => id !== null);
        if (confirmedIds.length > 0) remove(new Set([...immediate, ...confirmedIds]));
      });
    }
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

  return {
    setActiveId, addTerminal, closeTerminal, closeTerminals, closeTerminalsForTask,
    setServerId, setStatus, renameTerminal, reorderTerminal,
  };
}
