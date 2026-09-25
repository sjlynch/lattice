import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchTerminalServerStatus, type TerminalServerStatus } from '../api';
import { deriveTerminalServerChip } from './terminalServerChipDerive';

// A deferred terminal-server update is otherwise invisible: the backend logs it
// once and keeps the old executor for as long as any pty is open — with the
// user's own terminals always open, that can be forever. Polled (cheap: one
// loopback /health + /sessions on the backend) rather than pushed, since it
// only changes on a backend restart or when the last terminal closes.
const POLL_MS = 60_000;

export function TerminalServerChip() {
  const [status, setStatus] = useState<TerminalServerStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      fetchTerminalServerStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        // A backend mid-restart (or one that predates the route) is "unknown":
        // show nothing rather than a stale chip.
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);

  const chip = deriveTerminalServerChip(status);
  if (!chip) return null;
  return (
    <span className="appbar-term-update" title={chip.title} role="status">
      <RefreshCw size={12} className="appbar-term-update-icon" />
      <span className="appbar-term-update-label">{chip.label}</span>
    </span>
  );
}
