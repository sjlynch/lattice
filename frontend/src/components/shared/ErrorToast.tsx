import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, X } from 'lucide-react';

// Error toast with copy-to-clipboard. Used by TaskBoard and Workflows;
// extracted here so both share the same look and clipboard fallback.

export function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // Fallback for environments where clipboard API isn't available.
      const ta = document.createElement('textarea');
      ta.value = message;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing else to try */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="task-error-toast" role="alert">
      <span className="task-error-toast-icon" aria-hidden>
        <AlertTriangle size={14} />
      </span>
      <span className="task-error-toast-msg">{message}</span>
      <span className="task-error-toast-actions">
        <button
          className={`task-error-toast-btn ${copied ? 'copied' : ''}`}
          onClick={copy}
          title={copied ? 'Copied' : 'Copy message'}
          aria-label="Copy error message"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          className="task-error-toast-btn"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </span>
    </div>
  );
}
