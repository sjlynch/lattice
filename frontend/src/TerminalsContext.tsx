import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';

export type TerminalSpec = {
  id: string;
  label: string;
  cwd: string;
  initialCommand?: string;
};

type Ctx = {
  terminals: TerminalSpec[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  addTerminal: (spec: Omit<TerminalSpec, 'id'>) => string;
  closeTerminal: (id: string) => void;
};

const TerminalsContext = createContext<Ctx | null>(null);

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const [terminals, setTerminals] = useState<TerminalSpec[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const addTerminal = useCallback(
    (spec: Omit<TerminalSpec, 'id'>): string => {
      const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setTerminals((ts) => [...ts, { ...spec, id }]);
      setActiveId(id);
      return id;
    },
    [],
  );

  const closeTerminal = useCallback((id: string) => {
    setTerminals((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      if (idx === -1) return ts;
      const next = ts.filter((t) => t.id !== id);
      setActiveId((current) => {
        if (current !== id) return current;
        if (next.length === 0) return null;
        const fallbackIdx = Math.min(idx, next.length - 1);
        return next[fallbackIdx].id;
      });
      return next;
    });
  }, []);

  return (
    <TerminalsContext.Provider
      value={{ terminals, activeId, setActiveId, addTerminal, closeTerminal }}
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
