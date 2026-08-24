import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { checkGit, type ProjectGitProbe } from '../../api';
import { GitSetupDialog } from './GitSetupDialog';

// One git-setup action, three call sites (navbar chip, first task create, ▶
// run). Modelled on ConfirmProvider: mount one <GitSetupProvider> near the app
// root and `await ensureGitRepo(path)` wherever a non-git project would
// otherwise dead-end on a backend 400.
//
//   if (!(await ensureGitRepo(activeFolder))) return;
//   …carry on with what the user was already doing
//
// Resolves true when the project is (or has just become) a git repo, false when
// the user cancelled or the folder can't be initialized.

type GitSetupApi = {
  ensureGitRepo: (projectPath: string) => Promise<boolean>;
};

const GitSetupContext = createContext<GitSetupApi | null>(null);
// Bumped after every successful init. It lives in its own context so a bump
// re-renders only the things that actually watch git state (the navbar chip),
// not every caller that merely holds on to `ensureGitRepo`.
const GitSetupNonceContext = createContext(0);

export function useGitSetup(): GitSetupApi {
  const ctx = useContext(GitSetupContext);
  if (!ctx) throw new Error('useGitSetup must be used within a <GitSetupProvider>');
  return ctx;
}

/** Changes whenever a repo was just created — re-run git fetches/subscriptions on it. */
export function useGitSetupNonce(): number {
  return useContext(GitSetupNonceContext);
}

type Request = { id: number; project: string; probe: ProjectGitProbe };

export function GitSetupProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [nonce, setNonce] = useState(0);
  // The pending promise's resolver, held in a ref so settling is idempotent
  // (Escape and a footer button can both fire for one dismissal).
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);
  const requestSeq = useRef(0);
  // One probe (and at most one dialog) per project at a time. "Run all" fires
  // ensureGitRepo once per task in a synchronous loop; without this each call
  // would open its own dialog, cancelling the one before it, and the user would
  // answer a prompt that no longer belongs to anything.
  const inFlight = useRef(new Map<string, Promise<boolean>>());

  const settle = useCallback((ok: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(ok);
  }, []);

  const ask = useCallback((project: string, probe: ProjectGitProbe) => {
    // A new request supersedes whatever was pending so its awaiter unblocks.
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setRequest({ id: (requestSeq.current += 1), project, probe });
    });
  }, []);

  const finish = useCallback(
    (ok: boolean) => {
      if (ok) setNonce((n) => n + 1);
      settle(ok);
    },
    [settle],
  );

  const ensureGitRepo = useCallback(
    (projectPath: string): Promise<boolean> => {
      if (!projectPath) return Promise.resolve(false);
      const pending = inFlight.current.get(projectPath);
      if (pending) return pending;

      const run = (async () => {
        let probe: ProjectGitProbe | null;
        try {
          probe = (await checkGit(projectPath)).git ?? null;
        } catch (err) {
          probe = {
            state: 'error',
            initable: false,
            reason: (err as Error).message,
          };
        }
        // Already a repo — the overwhelmingly common case, and it has to cost
        // the caller nothing visible: no dialog, no flash, no extra click.
        //
        // A missing probe means the backend predates this contract. Wave the
        // caller through rather than blocking it: the pre-existing error path
        // (a 400 with the backend's own message) is strictly better than a
        // dialog Lattice can't populate.
        if (!probe || probe.state === 'repo') return true;
        return ask(projectPath, probe);
      })();

      const tracked = run.finally(() => {
        inFlight.current.delete(projectPath);
      });
      inFlight.current.set(projectPath, tracked);
      return tracked;
    },
    [ask],
  );

  // Stable identity so opening/closing the dialog doesn't re-render every
  // useGitSetup() consumer (the nonce rides its own context for that reason).
  const api = useMemo<GitSetupApi>(() => ({ ensureGitRepo }), [ensureGitRepo]);

  return (
    <GitSetupContext.Provider value={api}>
      <GitSetupNonceContext.Provider value={nonce}>
        {children}
        {request && (
          <GitSetupDialog
            key={request.id}
            project={request.project}
            probe={request.probe}
            onDone={finish}
          />
        )}
      </GitSetupNonceContext.Provider>
    </GitSetupContext.Provider>
  );
}
