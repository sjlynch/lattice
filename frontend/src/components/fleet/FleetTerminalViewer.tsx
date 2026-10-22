import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, X } from 'lucide-react';
import { fetchTerminalScreen, HttpError, sendTerminalText } from '../../api';

type Props = {
  id: string;
  label: string;
  projectName: string;
  // A paired PC this terminal lives on (through the peer proxy).
  machine?: string;
  onClose: () => void;
};

const POLL_MS = 1500;

// A live, text-rendered view of any project's terminal (the backend renders
// the pty through a headless xterm), with a line to type into it. Read-mostly
// by design: the full interactive pane lives in that project's sidebar.
export function FleetTerminalViewer({ id, label, projectName, machine, onClose }: Props) {
  const [text, setText] = useState('');
  const [gone, setGone] = useState(false);
  const [draft, setDraft] = useState('');
  const [submit, setSubmit] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setGone(false);
    setText('');
    const load = () => {
      if (document.hidden) return;
      fetchTerminalScreen(id, 400, machine)
        .then((s) => { if (!cancelled) setText(s.tail); })
        .catch((err) => { if (!cancelled && err instanceof HttpError && err.status === 404) setGone(true); });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [id, machine]);

  // Follow the bottom unless the user scrolled up to read.
  useEffect(() => {
    const el = preRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const send = useCallback((value: string, enter: boolean) => {
    setSendError(null);
    sendTerminalText(id, value, enter, machine)
      .then(() => setDraft(''))
      .catch((err) => setSendError(err instanceof Error ? err.message : String(err)));
  }, [id, machine]);

  return (
    <div className="fleet-term">
      <div className="fleet-term-head">
        <span className="fleet-term-title">
          <strong>{label}</strong>
          <span className="fleet-muted"> · {projectName}{machine ? ` · on ${machine}` : ''}</span>
        </span>
        <button className="icon-btn sm" onClick={onClose} title="Back to activity" aria-label="Close terminal view">
          <X size={13} />
        </button>
      </div>
      <pre
        className="fleet-term-screen"
        ref={preRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {gone ? 'This terminal has ended.' : text || '…'}
      </pre>
      {!gone && (
        <form
          className="fleet-term-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft || submit) send(draft, submit);
          }}
        >
          <input
            className="text-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type into this terminal…"
            aria-label="Text to send"
          />
          <label className="fleet-check" title="Press Enter after the text">
            <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
            <CornerDownLeft size={12} />
          </label>
          <button type="submit" className="btn-primary sm">Send</button>
          <button type="button" className="btn-ghost sm" title="Send Esc" onClick={() => send('\x1b', false)}>Esc</button>
          <button type="button" className="btn-ghost sm" title="Send Ctrl+C" onClick={() => send('\x03', false)}>Ctrl+C</button>
        </form>
      )}
      {sendError && <div className="error-msg">{sendError}</div>}
    </div>
  );
}
