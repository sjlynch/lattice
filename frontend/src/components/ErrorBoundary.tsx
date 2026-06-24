import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

// Class-based React error boundary. React 18 unmounts the entire tree when an
// uncaught render exception reaches the root, so without one of these a single
// null-ref in the force graph or a malformed backend payload blanks the whole
// app to a white screen. Wrap <App /> (and optionally crash-prone subtrees like
// the force graph) with this so a render fault shows a recoverable fallback
// instead.

interface Props {
  children: ReactNode;
  // Heading for the fallback. Defaults to a generic message; pass something
  // specific for a subtree boundary (e.g. "The file graph crashed").
  title?: string;
  // Smaller, container-filling variant for subtree boundaries that should not
  // take over the whole viewport.
  compact?: boolean;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the full error + React component stack for debugging; React's own
    // overlay is dev-only, so this is the only trace in a production build.
    console.error('ErrorBoundary caught an error:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  reload = () => {
    window.location.reload();
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const { title = 'Something went wrong', compact = false } = this.props;
    const message = error.message || String(error);

    return (
      <div className={`error-boundary${compact ? ' compact' : ''}`} role="alert">
        <div className="error-boundary-card">
          <span className="error-boundary-icon" aria-hidden>
            <AlertTriangle size={compact ? 20 : 28} />
          </span>
          <div className="error-boundary-title">{title}</div>
          <pre className="error-boundary-msg">{message}</pre>
          {componentStack && (
            <details className="error-boundary-details">
              <summary>Component stack</summary>
              <pre className="error-boundary-stack">{componentStack}</pre>
            </details>
          )}
          <button
            className="btn-primary error-boundary-reload"
            onClick={this.reload}
            type="button"
          >
            <RotateCcw size={14} />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
