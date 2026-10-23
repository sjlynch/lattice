import { useCallback, useEffect, useState } from 'react';
import { Copy, X } from 'lucide-react';
import {
  addPeerRemote,
  createPeerInvite,
  fetchPeers,
  removePeerRemote,
  revokePeerGrant,
  setPeerGateway,
  type PeerInvite,
  type PeerScope,
  type PeersView,
} from '../../api';
import { ago } from './fleetDerive';

type Props = { onClose: () => void; onChanged: () => void };

const SCOPE_HELP: Record<PeerScope, string> = {
  read: 'see projects, boards, runs and plan usage',
  operate: '+ create and run tasks, start workflows and merges, launch agents. Agents run code as you on this PC, so give this only to a PC you trust as much as this one',
  terminals: '+ read, type into and wait on any terminal (the same trust as operate)',
};

// Pairing other PCs: this PC's gateway (off by default), invites for PCs that
// should reach this one, and the PCs this one is paired to. Every change here
// is browser-only on the backend.
export function FleetPeersPanel({ onClose, onChanged }: Props) {
  const [view, setView] = useState<PeersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteName, setInviteName] = useState('');
  const [inviteScope, setInviteScope] = useState<PeerScope>('operate');
  const [inviteHost, setInviteHost] = useState('');
  const [invite, setInvite] = useState<PeerInvite | null>(null);
  const [remoteName, setRemoteName] = useState('');
  const [connection, setConnection] = useState('');
  const [busy, setBusy] = useState(false);
  const [portDraft, setPortDraft] = useState('');

  const load = useCallback(() => {
    fetchPeers().then((v) => { setView(v); setInviteHost((h) => h || v.gateway.addresses[0] || ''); }).catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = (p: Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    p.then(() => { after?.(); load(); onChanged(); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (!view) return <div className="fleet-peers"><div className="fleet-muted fleet-empty">{error ?? 'Loading…'}</div></div>;
  const g = view.gateway;
  return (
    <div className="fleet-peers">
      <div className="fleet-term-head">
        <strong>Other PCs</strong>
        <button className="icon-btn sm" onClick={onClose} title="Back to activity" aria-label="Close PCs"><X size={13} /></button>
      </div>
      {error && <div className="error-msg">{error}</div>}

      <section className="fleet-peers-section">
        <label className="fleet-check">
          <input type="checkbox" checked={g.enabled} disabled={busy} onChange={(e) => act(setPeerGateway(e.target.checked))} />
          Let paired PCs connect to this one (port {g.port})
        </label>
        <div className="fleet-prompt-row">
          <input className="text-input fleet-port" value={portDraft || String(g.port)} onChange={(e) => setPortDraft(e.target.value.replace(/D/g, ''))} aria-label="Gateway port" />
          <button className="btn-ghost sm" disabled={busy || !portDraft || Number(portDraft) === g.port} onClick={() => act(setPeerGateway(g.enabled, Number(portDraft)), () => setPortDraft(''))}>Set port</button>
        </div>
        <div className="fleet-muted">
          {g.enabled ? (g.listening ? `Listening on ${g.addresses.join(', ') || 'this PC'}:${g.port} — encrypted, paired PCs only.` : `Not listening${g.error ? `: ${g.error}` : ''}.`) : 'Off: nothing on the network can reach this Lattice.'}
        </div>
      </section>

      <section className="fleet-peers-section">
        <div className="fleet-peers-title">Invite a PC to this one</div>
        <div className="fleet-prompt-row">
          <input className="text-input" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Its name, e.g. laptop" aria-label="Name of the PC to invite" />
          <select className="text-input" value={inviteScope} onChange={(e) => setInviteScope(e.target.value as PeerScope)} aria-label="What it may do">
            {(['read', 'operate', 'terminals'] as PeerScope[]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {g.addresses.length > 1 && (
            <select className="text-input" value={inviteHost} onChange={(e) => setInviteHost(e.target.value)} aria-label="Address it should use">
              {g.addresses.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          <button className="btn-primary sm" disabled={busy || !inviteName.trim()} onClick={() => act(createPeerInvite(inviteName.trim(), inviteScope, inviteHost || undefined).then(setInvite), () => setInviteName(''))}>
            Create invite
          </button>
        </div>
        <div className="fleet-muted">{inviteScope}: {SCOPE_HELP[inviteScope]}</div>
        {invite && (
          <div className="fleet-invite">
            <div>Paste this into Fleet → PCs on <strong>{invite.name}</strong>. It is shown once — treat it like a password.</div>
            <div className="fleet-invite-row">
              <code className="fleet-invite-code">{invite.connection}</code>
              <button className="icon-btn sm" title="Copy" aria-label="Copy connection string" onClick={() => void navigator.clipboard?.writeText(invite.connection)}><Copy size={12} /></button>
            </div>
            {!g.enabled && <div className="fleet-muted">Turn on “Let paired PCs connect” above, or it can’t connect.</div>}
          </div>
        )}
        {view.grants.length > 0 && (
          <ul className="fleet-peers-list">
            {view.grants.map((x) => (
              <li key={x.identity}>
                <span><strong>{x.name}</strong> <span className="fleet-muted">· {x.scope} · {x.lastSeenAt ? `seen ${ago(x.lastSeenAt, Date.now())} ago` : 'never connected'}</span></span>
                <button className="btn-ghost sm" disabled={busy} onClick={() => act(revokePeerGrant(x.identity))}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fleet-peers-section">
        <div className="fleet-peers-title">Pair with another PC</div>
        <div className="fleet-prompt-row">
          <input className="text-input" value={remoteName} onChange={(e) => setRemoteName(e.target.value)} placeholder="Name it, e.g. gpu-pc" aria-label="Name for the other PC" />
          <input className="text-input" value={connection} onChange={(e) => setConnection(e.target.value)} placeholder="lattice-peer:1:… (its invite)" aria-label="Connection string" />
          <button className="btn-primary sm" disabled={busy || !remoteName.trim() || !connection.trim()} onClick={() => act(addPeerRemote(remoteName.trim(), connection.trim()), () => { setRemoteName(''); setConnection(''); })}>
            Pair
          </button>
        </div>
        {view.remotes.length > 0 && (
          <ul className="fleet-peers-list">
            {view.remotes.map((r) => (
              <li key={r.name}>
                <span><strong>{r.name}</strong> <span className="fleet-muted">· {r.host}:{r.port}</span></span>
                <button className="btn-ghost sm" disabled={busy} onClick={() => act(removePeerRemote(r.name))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
