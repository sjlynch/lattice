import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { RendererStatus } from './rendererStatus';

// Recoverable overlay for a WebGL fault, shown over the (empty or frozen)
// graph viewport instead of letting the fault reach the error boundary and
// blank the subtree behind a raw stack trace. Render-only; the retry handler
// remounts the coordinator (see ForceGraphView).

type Props = {
  status: Exclude<RendererStatus, { kind: 'ok' }>;
  onRetry: () => void;
};

// Ordered most-likely-first for the machine state that actually produces this:
// a long-lived tab that has been through a memory squeeze.
const WEBGL_HINTS = [
  'Close other 3D / video / GPU-heavy tabs and apps, then retry — a page only gets a handful of WebGL contexts.',
  'If it keeps failing, fully quit and reopen the browser. After a GPU-process crash (running out of memory is the usual cause) Chrome hands out no new contexts until it restarts — reloading the tab is not enough.',
  'Still nothing? Check chrome://gpu and re-enable Settings → System → "Use graphics acceleration when available".',
];

const OTHER_HINTS = [
  'Retry below; if it keeps failing, reload the page and check the browser console for the error above.',
];

export function GraphRendererNotice({ status, onRetry }: Props) {
  const lost = status.kind === 'lost';
  const hints = lost ? [] : status.webgl ? WEBGL_HINTS : OTHER_HINTS;

  return (
    <div className="graph-renderer-notice" role="alert">
      <div className="graph-renderer-notice-card">
        <span className="graph-renderer-notice-icon" aria-hidden>
          <AlertTriangle size={22} />
        </span>
        <div className="graph-renderer-notice-title">
          {lost ? 'GPU context lost' : '3D graph unavailable'}
        </div>
        <p className="graph-renderer-notice-body">
          {lost
            ? "The browser took back the graph's WebGL context. It usually restores itself within a few seconds — if the view stays frozen, rebuild it."
            : "The browser wouldn't create a WebGL context for the file graph. Everything else in Lattice — tasks, terminals, workflows — is unaffected."}
        </p>
        {!lost && (
          <pre className="graph-renderer-notice-msg">{status.message}</pre>
        )}
        {hints.length > 0 && (
          <ul className="graph-renderer-notice-hints">
            {hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        )}
        <button
          className="btn-primary graph-renderer-notice-retry"
          onClick={onRetry}
          type="button"
        >
          <RotateCcw size={14} />
          {lost ? 'Rebuild graph' : 'Retry'}
        </button>
      </div>
    </div>
  );
}
