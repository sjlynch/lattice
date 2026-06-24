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
import { Modal } from '../Modal';

// Shared confirmation dialog. Two shapes Lattice needs:
//   (a) destructive confirm — a danger-styled primary + Cancel; the caller
//       supplies the (often interpolated) message.
//   (b) unsaved-changes confirm — Save / Discard / Cancel, resolving to which
//       action the user chose.
//
// Mount one <ConfirmProvider> near the app root; callers `await` a result via
// the useConfirm() hook, e.g. `if (await confirm({ message })) …` or
// `const choice = await confirmUnsaved()`. Escape / backdrop = Cancel, Enter =
// the default/primary action (Delete for danger, Save for unsaved).

export type UnsavedChoice = 'save' | 'discard' | 'cancel';
type ConfirmChoice = 'confirm' | UnsavedChoice;

export type DangerConfirmOptions = {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type UnsavedConfirmOptions = {
  title?: string;
  message?: ReactNode;
  saveLabel?: string;
  discardLabel?: string;
  cancelLabel?: string;
};

type DangerRequest = DangerConfirmOptions & { kind: 'danger' };
type UnsavedRequest = UnsavedConfirmOptions & { kind: 'unsaved' };
type ConfirmRequest = DangerRequest | UnsavedRequest;

type ConfirmApi = {
  /** Destructive confirm — resolves true if the user confirmed. */
  confirm: (options: DangerConfirmOptions) => Promise<boolean>;
  /** Unsaved-changes confirm — resolves the chosen action. */
  confirmUnsaved: (options?: UnsavedConfirmOptions) => Promise<UnsavedChoice>;
};

const ConfirmContext = createContext<ConfirmApi | null>(null);

export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  // The pending promise resolver. Held in a ref so settle() is idempotent
  // (Escape + a focused-button Enter can both fire for one dismissal) and so a
  // second confirm() supersedes the first cleanly.
  const resolveRef = useRef<((choice: ConfirmChoice) => void) | null>(null);

  const settle = useCallback((choice: ConfirmChoice) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(choice);
  }, []);

  const open = useCallback((req: ConfirmRequest): Promise<ConfirmChoice> => {
    // A new request cancels whatever was pending so its awaiter unblocks.
    resolveRef.current?.('cancel');
    return new Promise<ConfirmChoice>((resolve) => {
      resolveRef.current = resolve;
      setRequest(req);
    });
  }, []);

  const confirm = useCallback<ConfirmApi['confirm']>(
    (options) => open({ kind: 'danger', ...options }).then((c) => c === 'confirm'),
    [open],
  );

  const confirmUnsaved = useCallback<ConfirmApi['confirmUnsaved']>(
    (options) =>
      open({ kind: 'unsaved', ...options }).then((c) =>
        c === 'cancel' ? 'cancel' : (c as UnsavedChoice),
      ),
    [open],
  );

  // Enter activates the primary action. Escape / backdrop are handled by Modal
  // (its onClose → settle('cancel')).
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        settle(request.kind === 'danger' ? 'confirm' : 'save');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, settle]);

  // Stable identity so opening/closing a dialog doesn't re-render every
  // useConfirm() consumer across the app (confirm/confirmUnsaved are stable).
  const api = useMemo<ConfirmApi>(
    () => ({ confirm, confirmUnsaved }),
    [confirm, confirmUnsaved],
  );

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Modal open={!!request} onClose={() => settle('cancel')} width={420}>
        {request && (
          <>
            <div className="modal-header">
              {request.title ??
                (request.kind === 'danger' ? 'Confirm' : 'Unsaved changes')}
            </div>
            <div className="modal-body">
              <div className="confirm-dialog-message">
                {request.message ??
                  (request.kind === 'unsaved'
                    ? 'You have unsaved changes.'
                    : null)}
              </div>
            </div>
            <div className="modal-footer">
              {request.kind === 'danger' ? (
                <>
                  <button className="btn-ghost" onClick={() => settle('cancel')}>
                    {request.cancelLabel ?? 'Cancel'}
                  </button>
                  <button
                    className="btn-danger"
                    autoFocus
                    onClick={() => settle('confirm')}
                  >
                    {request.confirmLabel ?? 'Confirm'}
                  </button>
                </>
              ) : (
                <>
                  <button className="btn-ghost" onClick={() => settle('cancel')}>
                    {request.cancelLabel ?? 'Cancel'}
                  </button>
                  <button className="btn-ghost" onClick={() => settle('discard')}>
                    {request.discardLabel ?? 'Discard'}
                  </button>
                  <button
                    className="btn-primary"
                    autoFocus
                    onClick={() => settle('save')}
                  >
                    {request.saveLabel ?? 'Save'}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}
