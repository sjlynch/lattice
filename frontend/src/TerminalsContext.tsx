import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Ctx,
  Persisted,
  TerminalSpec,
} from './terminal/terminalTypes';
import { loadPersisted, persist } from './terminal/terminalStorage';
import { pickInitialActiveId } from './terminal/terminalState';
import { useTerminalRegistrySync } from './terminal/useTerminalRegistrySync';
import { useTerminalActions } from './terminal/useTerminalActions';
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
  // Child cleanup effects issue commands before the provider's passive
  // effects run. Publish the committed list first so newly arrived tabs can
  // be closed without relying on an extra render from a no-op removal.
  useLayoutEffect(() => {
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

  const {
    setActiveId, addTerminal, closeTerminal, closeTerminals, closeTerminalsForTask,
    setServerId, setStatus, renameTerminal, reorderTerminal,
  } = useTerminalActions({
    setTerminals, setActiveIdState, terminalsRef, activeFolderRef, addedDuringFetchRef,
  });

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
