import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type TerminalSpec = {
  id: string;            // local UI id
  serverId?: string;     // backend session id, set after WS attaches
  label: string;
  cwd: string;
  initialCommand?: string;
};

type Persisted = {
  terminals: TerminalSpec[];
  activeId: string | null;
};

const STORAGE_KEY = 'lattice.terminals';

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { terminals: [], activeId: null };
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || !Array.isArray(parsed.terminals)) {
      return { terminals: [], activeId: null };
    }
    return {
      terminals: parsed.terminals.filter(
        (t): t is TerminalSpec =>
          !!t && typeof t.id === 'string' && typeof t.cwd === 'string',
      ),
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
    };
  } catch {
    return { terminals: [], activeId: null };
  }
}

function persist(state: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode — ignore */
  }
}

type Ctx = {
  terminals: TerminalSpec[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  addTerminal: (spec: Omit<TerminalSpec, 'id'>) => string;
  closeTerminal: (id: string) => void;
  setServerId: (id: string, serverId: string) => void;
};

const TerminalsContext = createContext<Ctx | null>(null);

export function TerminalsProvider({ children }: { children: ReactNode }) {
  // Initialize from localStorage so terminals persist across reloads.
  const initial = useRef<Persisted | null>(null);
  if (initial.current === null) initial.current = loadPersisted();

  const [terminals, setTerminals] = useState<TerminalSpec[]>(
    initial.current.terminals,
  );
  const [activeId, setActiveIdState] = useState<string | null>(
    initial.current.activeId &&
      initial.current.terminals.some((t) => t.id === initial.current!.activeId)
      ? initial.current.activeId
      : initial.current.terminals[0]?.id ?? null,
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
    (spec: Omit<TerminalSpec, 'id'>): string => {
      const id = `term_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      setTerminals((ts) => [...ts, { ...spec, id }]);
      setActiveIdState(id);
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
    const target = terminalsRef.current.find((t) => t.id === id);
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
    if (target.serverId) {
      void fetch(`/api/terminals/${encodeURIComponent(target.serverId)}`, {
        method: 'DELETE',
      }).catch(() => {
        /* ignore */
      });
    }
    const idx = terminalsRef.current.findIndex((t) => t.id === id);
    const next = terminalsRef.current.filter((t) => t.id !== id);
    setTerminals(next);
    setActiveIdState((current) => {
      if (current !== id) return current;
      if (next.length === 0) return null;
      const fallbackIdx = Math.min(Math.max(0, idx), next.length - 1);
      return next[fallbackIdx]?.id ?? null;
    });
  }, []);

  const setServerId = useCallback((id: string, serverId: string) => {
    setTerminals((ts) =>
      ts.map((t) => (t.id === id ? { ...t, serverId } : t)),
    );
  }, []);

  return (
    <TerminalsContext.Provider
      value={{
        terminals,
        activeId,
        setActiveId,
        addTerminal,
        closeTerminal,
        setServerId,
      }}
    >
      {children}
    </TerminalsContext.Provider>
  );
}

export function useTerminals(): Ctx {
  const ctx = useContext(TerminalsContext);
  if (!ctx) throw new Error('TerminalsProvider missing');
  return ctx;
}
