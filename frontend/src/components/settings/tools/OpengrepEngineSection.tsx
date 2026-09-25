import { startOpengrepInstall, type OpengrepStatus } from '../../../api';
import { SettingsSection } from '../SettingsSection';
import { formatBytes } from './toolsTabUtils';

type Props = {
  status: OpengrepStatus | null;
  statusError: string | null;
  actionError: string | null;
  runAction: (fn: () => Promise<unknown>) => Promise<void>;
};

// "Opengrep (static analysis)": the resolved engine, the managed install
// button + its download/verify progress, and any install/pack action error.
export function OpengrepEngineSection({ status, statusError, actionError, runAction }: Props) {
  const engine = status?.engine ?? null;
  const job = status?.installJob ?? null;
  const installRunning = job?.status === 'running';
  const platform = status?.platformAsset ?? null;

  return (
    <SettingsSection
      title="Opengrep (static analysis)"
      infoLabel="About Opengrep"
      info={
        <>
          <p>
            Opengrep is a local, offline static-analysis (SAST) engine — the LGPL-2.1 community
            fork of Semgrep CE. Lattice runs it as a separate process over your project and hands
            agents a compact <em>digest</em> of the findings: an "Opengrep" workflow step (the
            quick-add chip or the "Security review (Opengrep)" template) scans the project before
            the agent starts, and every session has the <code>opengrep_scan</code> /{' '}
            <code>opengrep_findings</code> / <code>opengrep_ignore</code> MCP tools.
          </p>
          <p>
            The engine and the rule packs are downloaded into <code>~/.lattice/opengrep/</code>{' '}
            only when you click Install here, verified against the SHA-256 digests pinned in this
            Lattice build (which were Sigstore-verified when pinned), and never committed to or
            shipped with Lattice. A copy of <code>opengrep</code> already on your PATH is used
            instead and never overridden.
          </p>
        </>
      }
    >
      {statusError && <div className="error-msg">{statusError}</div>}
      {!status && !statusError && <div className="settings-section-sub">Checking…</div>}
      {status && (
        <div className="tools-engine">
          <div className="tools-engine-state">
            {engine ? (
              <>
                <span className="tools-badge ok">installed</span>
                <span>
                  Opengrep <strong>{engine.version}</strong>{' '}
                  {engine.source === 'path' ? '(your own install, on PATH)' : '(managed by Lattice)'}
                </span>
                <code className="tools-path" title={engine.command}>
                  {engine.command}
                </code>
              </>
            ) : (
              <>
                <span className="tools-badge off">not installed</span>
                <span>
                  Lattice pins Opengrep <strong>{status.managedVersion}</strong>
                  {platform ? ` (${platform.asset}, ~50 MB)` : ''}.
                </span>
              </>
            )}
          </div>
          {platform?.note && <div className="settings-section-sub">{platform.note}</div>}
          {!platform && (
            <div className="settings-section-sub">
              No Opengrep build exists for this platform. Install it yourself and it will be picked
              up from PATH.
            </div>
          )}
          {engine?.source === 'path' && !status.managedInstalled && (
            <div className="settings-section-sub">
              Your PATH install takes precedence; the managed download is not needed.
            </div>
          )}
          {(!engine || (engine.source === 'managed' && engine.version !== status.managedVersion)) &&
            platform && (
              <div className="settings-control-row">
                <button
                  className="btn-primary"
                  disabled={installRunning}
                  onClick={() => void runAction(() => startOpengrepInstall())}
                >
                  {installRunning
                    ? 'Installing…'
                    : `Install Opengrep ${status.managedVersion}`}
                </button>
              </div>
            )}
          {job && (
            <div className={`tools-job ${job.status}`}>
              {job.status === 'running' && (
                <>
                  <div className="tools-progress">
                    <div
                      className="tools-progress-bar"
                      style={{
                        width: `${job.totalBytes ? Math.min(100, (100 * job.receivedBytes) / job.totalBytes) : 0}%`,
                      }}
                    />
                  </div>
                  <div className="settings-section-sub">
                    {job.phase === 'downloading'
                      ? `Downloading ${formatBytes(job.receivedBytes)} of ${formatBytes(job.totalBytes)}`
                      : job.phase === 'verifying'
                        ? 'Verifying checksum…'
                        : 'Checking the binary runs…'}
                  </div>
                </>
              )}
              {job.status === 'done' && (
                <div className="settings-section-sub">Installed {job.version} ({job.asset}).</div>
              )}
              {job.status === 'failed' && <div className="error-msg">{job.error}</div>}
            </div>
          )}
        </div>
      )}
      {actionError && <div className="error-msg">{actionError}</div>}
    </SettingsSection>
  );
}
