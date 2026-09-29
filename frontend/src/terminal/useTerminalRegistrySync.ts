import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { RestoreNotice, TerminalSpec } from './terminalTypes';
import { fetchLiveTerminalIds } from './terminalApi';
import {
  applyTerminalTabsEvent,
  applyRestoreSummary,
  mergeRegistryTabs,
  restorableCount,
} from './terminalRegistrySync';
import {
  fetchTerminalTabs,
  restoreTerminalTabs,
  subscribeTerminalTabs,
} from '../api/terminalTabs';
import type { RestoreSummary, RestoreTerminalsMode, TerminalRecord } from '../api/types/terminalTabs';

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

type Options = {
  // The open project (drives the fetch / subscription and the auto-restore).
  activeFolder: string;
  // The project's `restoreTerminalsOnOpen` setting, or null while loading.
  restoreMode: RestoreTerminalsMode | null;
  setTerminals: Dispatch<SetStateAction<TerminalSpec[]>>;
  terminalsRef: MutableRefObject<TerminalSpec[]>;
  // Mirrors `activeFolder`; read by `runRestore` so it can stay stable.
  activeFolderRef: MutableRefObject<string>;
};

// Event generations belong to one subscription lifetime, so a response from
// before A -> B -> A cannot reconcile into the new visit to A.
type RegistrySession = {
  folder: string;
  generation: number;
  snapshotGeneration: number;
  changedAt: Map<string, number>;
};

function changedSince(session: RegistrySession, generation: number): Set<string> {
  return new Set([...session.changedAt].filter(([, at]) => at > generation).map(([id]) => id));
}

export type TerminalRegistrySync = {
  runRestore: (opts?: { retry?: boolean }) => Promise<RestoreSummary | null>;
  lastRestore: RestoreNotice | null;
  setLastRestore: Dispatch<SetStateAction<RestoreNotice | null>>;
  restorePrompt: { count: number } | null;
  setRestorePrompt: Dispatch<SetStateAction<{ count: number } | null>>;
  addedDuringFetchRef: MutableRefObject<Set<string> | null>;
};

// Backend terminal-registry orchestration for `TerminalsProvider`: fetch on
// project open + live subscription, and the per-project on-open restore.
export function useTerminalRegistrySync({
  activeFolder,
  restoreMode,
  setTerminals,
  terminalsRef,
  activeFolderRef,
}: Options): TerminalRegistrySync {
  const [lastRestore, setLastRestore] = useState<RestoreNotice | null>(null);
  const [restorePrompt, setRestorePrompt] = useState<{ count: number } | null>(null);

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
  const registrySessionRef = useRef<RegistrySession | null>(null);
  const restoreInFlightRef = useRef<Map<string, {
    session: RegistrySession;
    promise: Promise<RestoreSummary | null>;
  }>>(new Map());

  const runRestore = useCallback(async (opts: { retry?: boolean } = {}): Promise<RestoreSummary | null> => {
    const folder = activeFolderRef.current;
    const session = registrySessionRef.current;
    if (!folder || !session || session.folder !== folder) return null;
    const inFlight = restoreInFlightRef.current.get(folder);
    if (inFlight?.session === session && !opts.retry) return inFlight.promise;
    const generation = session.generation;
    const requestedServerIds = new Map(terminalsRef.current.map((t) => [t.id, t.serverId] as const));
    let run: Promise<RestoreSummary | null> | null = null;
    run = (async () => {
      try {
        const summary = await restoreTerminalTabs(folder, opts);
        if (registrySessionRef.current !== session || activeFolderRef.current !== folder) return summary;
        setRestorePrompt(null);
        // The HTTP response is the authoritative summary for a restore THIS
        // tab asked for: the matching WS `restore-summary` can fire before
        // the socket is even open on a fresh page load. The WS event still
        // covers restores triggered from another browser tab.
        // A silent on-open pass colliding with an in-progress one stays silent;
        // an explicit click deserves the "already in progress" line.
        if (isNoteworthy(summary) && (summary.status !== 'already-running' || opts.retry)) {
          setLastRestore({ projectPath: folder, summary, at: Date.now() });
        }
        // Fall back to the acknowledgement when this client missed the WS
        // queue event. Tab events and any new pty/failure from a hello must
        // win; a hello that still names the requested dead pty can safely be
        // marked pending by the acknowledgement.
        const changedIds = changedSince(session, generation);
        const snapshotChanged = session.snapshotGeneration > generation;
        // This acknowledgement also supersedes a list request made before
        // the restore, even when no queue event reached our socket.
        for (const id of summary.relaunchedIds ?? []) {
          session.changedAt.set(id, ++session.generation);
        }
        setTerminals((ts) => registrySessionRef.current === session
          ? applyRestoreSummary(ts, summary, folder, requestedServerIds, changedIds, snapshotChanged)
          : ts);
        return summary;
      } catch (err) {
        console.warn('[lattice] terminal restore failed:', err);
        return null;
      } finally {
        if (run && restoreInFlightRef.current.get(folder)?.promise === run) restoreInFlightRef.current.delete(folder);
      }
    })();
    if (!opts.retry) restoreInFlightRef.current.set(folder, { session, promise: run });
    return run;
    // Stable on purpose: reads the folder from `activeFolderRef`, and
    // `setTerminals` is a React state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const session: RegistrySession = {
      folder: activeFolder, generation: 0, snapshotGeneration: 0, changedAt: new Map(),
    };
    registrySessionRef.current = session;
    const added = new Set<string>();
    addedDuringFetchRef.current = added;
    const unsub = subscribeTerminalTabs(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type === 'hello') {
        session.snapshotGeneration = ++session.generation;
        const keepIds = new Set(addedDuringFetchRef.current);
        setTerminals((ts) => cancelled ? ts : mergeRegistryTabs(ts, ev.tabs, activeFolder, keepIds));
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
      const id = ev.type === 'upsert' || ev.type === 'restored' ? ev.record.id : ev.id;
      session.changedAt.set(id, ++session.generation);
      setTerminals((ts) => applyTerminalTabsEvent(ts, ev));
    });
    // The HTTP fetch is what gates the auto-restore: it settles even when the
    // WS is slow to connect, and its result tells 'ask' mode how many tabs
    // are on offer.
    // A backend still booting (the dev runner restarting it under the page)
    // fails the first fetch; retry a few times before leaving it to the WS
    // `hello` above.
    const attempt = (n: number): void => {
      const generation = session.generation;
      void fetchTerminalTabs(activeFolder)
        .then((records) => {
          if (cancelled) return;
          // A complete WS snapshot supersedes the entire older HTTP view.
          // Otherwise preserve just the tabs changed by intervening events,
          // including tombstones and additions from another browser tab.
          if (session.snapshotGeneration <= generation) {
            const changedIds = changedSince(session, generation);
            const keepIds = new Set(added);
            setTerminals((ts) => cancelled ? ts : mergeRegistryTabs(ts, records, activeFolder, keepIds, changedIds));
            setRegistryLoaded((cur) => (cur && cur.folder === activeFolder ? cur : { folder: activeFolder, records }));
          }
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
      if (registrySessionRef.current === session) registrySessionRef.current = null;
      if (addedDuringFetchRef.current === added) addedDuringFetchRef.current = null;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return {
    runRestore,
    lastRestore,
    setLastRestore,
    restorePrompt,
    setRestorePrompt,
    addedDuringFetchRef,
  };
}
