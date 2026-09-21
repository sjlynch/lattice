import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  HttpError,
  fetchGlobalSettings,
  fetchOpengrepStatus,
  fetchUserSettings,
  installOpengrepRulePack,
  removeOpengrepRulePack,
  runOpengrepScan,
  startOpengrepInstall,
  type OpengrepProjectSettings,
  type OpengrepScanEnvelope,
  type OpengrepScanRecord,
  type OpengrepSeverity,
  type OpengrepStatus,
} from '../../api';
import { SettingsSection } from './SettingsSection';
import { useConfirm } from '../shared/ConfirmDialog';

// Packs whose licence carries a use condition (the Commons Clause forbids
// SELLING a product whose value derives substantially from the rules) get a
// confirmation before the download so the install click is an informed one.
// Lattice's own licence is unaffected either way — the rules are only ever
// downloaded here, never redistributed.
const needsLicenceAcknowledgement = (licence: string): boolean => /commons clause/i.test(licence);

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type ToolsTabHandle = {
  // Per-project Opengrep settings to persist on Save, or `undefined` when
  // untouched / not yet loaded (the clobber-guard every tab uses).
  getOpengrepProjectPatch: () => OpengrepProjectSettings | undefined;
  // Machine-global pack enables, same contract.
  getOpengrepGlobalPatch: () => { packs: Record<string, boolean> } | undefined;
};

// Status polling cadence while an install / pack fetch / scan is in flight.
const POLL_MS = 1500;
const SEVERITIES: OpengrepSeverity[] = ['ERROR', 'WARNING', 'INFO'];

type ProjectDraft = {
  severityFloor: OpengrepSeverity;
  ignoreRuleIds: string;
  ignoreFingerprints: string;
  extraRulePaths: string;
  excludeGlobs: string;
  digestBudgetKb: string;
};

const EMPTY_DRAFT: ProjectDraft = {
  severityFloor: 'WARNING',
  ignoreRuleIds: '',
  ignoreFingerprints: '',
  extraRulePaths: '',
  excludeGlobs: '',
  digestBudgetKb: '60',
};

function lines(v: string): string[] {
  return [...new Set(v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

function draftFromSettings(s: OpengrepProjectSettings | undefined): ProjectDraft {
  return {
    severityFloor: s?.severityFloor ?? 'WARNING',
    ignoreRuleIds: (s?.ignoreRuleIds ?? []).join('\n'),
    ignoreFingerprints: (s?.ignoreFingerprints ?? []).join('\n'),
    extraRulePaths: (s?.extraRulePaths ?? []).join('\n'),
    excludeGlobs: (s?.excludeGlobs ?? []).join('\n'),
    digestBudgetKb: String(s?.digestBudgetKb ?? 60),
  };
}

function settingsFromDraft(d: ProjectDraft): OpengrepProjectSettings {
  const kb = Number(d.digestBudgetKb);
  return {
    severityFloor: d.severityFloor,
    ignoreRuleIds: lines(d.ignoreRuleIds),
    ignoreFingerprints: lines(d.ignoreFingerprints),
    extraRulePaths: lines(d.extraRulePaths),
    excludeGlobs: lines(d.excludeGlobs),
    digestBudgetKb: Number.isFinite(kb) && kb >= 8 ? Math.floor(kb) : 60,
  };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString();
}

function describeScan(s: OpengrepScanRecord): string {
  return (
    `${s.findings} finding${s.findings === 1 ? '' : 's'} ` +
    `(${s.bySeverity.ERROR} ERROR / ${s.bySeverity.WARNING} WARNING / ${s.bySeverity.INFO} INFO) ` +
    `in ${s.scannedFiles} files, ${Math.round(s.durationMs / 1000)}s, ` +
    `${s.packIds.length ? s.packIds.join(' + ') : 'project rules only'}`
  );
}

// Settings → Tools: the Opengrep (SAST) engine + rule packs (machine-global,
// applied immediately from the buttons here) and this project's scan filter
// (persisted on Save with the rest of the dialog). Future pre-run tools
// (`npm audit`, `tsc`, test runners) join this tab.
export const ToolsTab = forwardRef<ToolsTabHandle, Props>(function ToolsTab(
  { active, open, activeFolder },
  ref,
) {
  const [status, setStatus] = useState<OpengrepStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [packDraft, setPackDraft] = useState<Record<string, boolean>>({});
  const [packTouched, setPackTouched] = useState(false);
  const [packLoaded, setPackLoaded] = useState(false);

  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [projectTouched, setProjectTouched] = useState(false);
  const [projectLoaded, setProjectLoaded] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<OpengrepScanEnvelope | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const { confirm } = useConfirm();
  const openRef = useRef(open);
  openRef.current = open;

  const refreshStatus = useCallback(async () => {
    try {
      const s = await fetchOpengrepStatus(activeFolder || undefined);
      if (!openRef.current) return null;
      setStatus(s);
      setStatusError(null);
      return s;
    } catch (err) {
      if (openRef.current) setStatusError((err as Error).message);
      return null;
    }
  }, [activeFolder]);

  // (Re)load everything each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPackLoaded(false);
    setPackTouched(false);
    setProjectLoaded(false);
    setProjectTouched(false);
    setScanResult(null);
    setScanError(null);
    setActionError(null);
    void refreshStatus();
    fetchGlobalSettings()
      .then((g) => {
        if (cancelled) return;
        setPackDraft({ ...(g.opengrep?.packs ?? {}) });
        setPackLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setPackLoaded(true);
      });
    if (activeFolder) {
      fetchUserSettings(activeFolder)
        .then((u) => {
          if (cancelled) return;
          setDraft(draftFromSettings(u.opengrep));
          setProjectLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setProjectLoaded(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, activeFolder, refreshStatus]);

  // Poll while something is in flight (engine install, a pack fetch, a scan).
  const busy =
    status?.installJob?.status === 'running' ||
    status?.packs.some((p) => p.job?.status === 'running') === true ||
    status?.project?.scanning === true ||
    scanning;
  useEffect(() => {
    if (!open || !busy) return;
    const t = setInterval(() => void refreshStatus(), POLL_MS);
    return () => clearInterval(t);
  }, [open, busy, refreshStatus]);

  useImperativeHandle(
    ref,
    () => ({
      getOpengrepProjectPatch: () =>
        projectLoaded && projectTouched ? settingsFromDraft(draft) : undefined,
      getOpengrepGlobalPatch: () =>
        packLoaded && packTouched ? { packs: { ...packDraft } } : undefined,
    }),
    [draft, packDraft, packLoaded, packTouched, projectLoaded, projectTouched],
  );

  const runAction = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message || String(err));
    }
    await refreshStatus();
  };

  const onScan = async () => {
    if (!activeFolder) return;
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    try {
      const r = await runOpengrepScan(activeFolder);
      setScanResult(r);
    } catch (err) {
      const e = err as HttpError;
      setScanError(e.code ? `${e.message} (${e.code})` : e.message || String(err));
    } finally {
      setScanning(false);
      await refreshStatus();
    }
  };

  const patchDraft = (p: Partial<ProjectDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setProjectTouched(true);
  };

  if (!active) return null;

  const engine = status?.engine ?? null;
  const job = status?.installJob ?? null;
  const installRunning = job?.status === 'running';
  const platform = status?.platformAsset ?? null;

  return (
    <>
      <SettingsSection
        title="Opengrep (static analysis)"
        infoLabel="About Opengrep"
        info={
          <>
            <p>
              Opengrep is a local, offline static-analysis (SAST) engine — the LGPL-2.1 community
              fork of Semgrep CE. Lattice runs it as a separate process over your project and hands
              agents a compact <em>digest</em> of the findings: a workflow agent step with the shield
              toggle on scans the project before the agent starts, and every session has the{' '}
              <code>opengrep_scan</code> / <code>opengrep_findings</code> MCP tools.
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

      <SettingsSection
        title="Rule packs"
        infoLabel="About rule packs"
        info={
          <>
            <p>
              Opengrep finds nothing without rules. Each pack below is fetched from its repository at
              the exact commit pinned in this Lattice build, pruned to rule files only, and stored in{' '}
              <code>~/.lattice/opengrep/rules/</code>. The enable checkbox decides which installed
              packs a scan uses; it is machine-wide.
            </p>
            <p>
              Rules under <code>&lt;project&gt;/.opengrep/rules/</code> are always loaded when that
              directory exists — the place for your own project-specific rules.
            </p>
          </>
        }
      >
        <div className="tools-packs">
          {(status?.packs ?? []).map((p) => {
            const enabled = packDraft[p.id] ?? p.defaultEnabled;
            const running = p.job?.status === 'running';
            return (
              <div key={p.id} className="tools-pack" data-pack={p.id}>
                <label className="settings-checkbox-row tools-pack-enable">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!packLoaded}
                    onChange={(e) => {
                      setPackDraft((d) => ({ ...d, [p.id]: e.target.checked }));
                      setPackTouched(true);
                    }}
                  />
                  <span className="tools-pack-label">{p.label}</span>
                </label>
                <div className="tools-pack-meta">
                  <span
                    className={`tools-badge ${/commons clause/i.test(p.licence) ? 'warn' : 'ok'}`}
                    title={p.note}
                  >
                    {p.licence}
                  </span>
                  {p.installed ? (
                    <span className="tools-pack-installed">
                      {p.installed.ruleCount} rules in {p.installed.ruleFiles} files ·{' '}
                      <code>{p.installed.commit.slice(0, 10)}</code>
                      {p.outdated && <span className="tools-badge warn">update available</span>}
                    </span>
                  ) : (
                    <span className="tools-badge off">not installed</span>
                  )}
                  <a href={p.homepage} target="_blank" rel="noreferrer" className="tools-pack-link">
                    source
                  </a>
                </div>
                <div className="settings-section-sub tools-pack-note">{p.note}</div>
                <div className="tools-pack-actions">
                  {(!p.installed || p.outdated) && (
                    <button
                      className="btn-primary"
                      disabled={running}
                      onClick={() =>
                        void (async () => {
                          if (!p.installed && needsLicenceAcknowledgement(p.licence)) {
                            const ok = await confirm({
                              title: `Install "${p.label}"?`,
                              confirmLabel: 'Install',
                              message: (
                                <>
                                  <p>
                                    This pack is licensed <strong>{p.licence}</strong>. The Commons Clause
                                    forbids <em>selling</em> a product or service whose value derives
                                    substantially from these rules. Scanning your own code with Lattice
                                    is fine; Lattice itself stays MIT because the rules are only
                                    downloaded to this machine, never redistributed.
                                  </p>
                                  <p>
                                    The rules are fetched at their pinned commit into{' '}
                                    <code>~/.lattice/opengrep/rules/{p.id}/</code> and used by every scan
                                    while the pack is enabled.
                                  </p>
                                </>
                              ),
                            });
                            if (!ok) return;
                          }
                          await runAction(() => installOpengrepRulePack(p.id));
                        })()
                      }
                    >
                      {running ? 'Fetching…' : p.installed ? 'Update' : 'Install'}
                    </button>
                  )}
                  {p.installed && (
                    <button
                      className="btn-ghost"
                      disabled={running}
                      onClick={() => void runAction(() => removeOpengrepRulePack(p.id))}
                    >
                      Remove
                    </button>
                  )}
                  {p.job?.status === 'failed' && <span className="error-msg">{p.job.error}</span>}
                </div>
              </div>
            );
          })}
          {status && status.packs.length === 0 && (
            <div className="settings-empty">No rule packs are defined in this build.</div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Scan filter (this project)"
        infoLabel="About the digest filter"
        info={
          <>
            <p>
              Agents never read the raw scan. They read a digest: findings at or above the severity
              floor, minus ignored rules and fingerprints, deduplicated, grouped by rule then file,
              under the byte budget. Everything here is per project and is applied before the digest
              is rendered.
            </p>
            <p>
              A rule id may be the full check id or any dot-suffix of it (
              <code>detect-child-process</code>). A fingerprint is the short <code>fp</code> shown in
              the digest (or the full one). One entry per line.
            </p>
          </>
        }
      >
        <div className="settings-control-row">
          <label className="settings-control-label" htmlFor="opengrep-severity-floor">
            Severity floor
          </label>
          <select
            id="opengrep-severity-floor"
            className="settings-select"
            value={draft.severityFloor}
            disabled={!projectLoaded}
            onChange={(e) => patchDraft({ severityFloor: e.target.value as OpengrepSeverity })}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s === 'INFO' ? 'INFO (show everything)' : s === 'WARNING' ? 'WARNING (default)' : 'ERROR only'}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-control-row">
          <label className="settings-control-label" htmlFor="opengrep-budget">
            Digest budget (KB)
          </label>
          <input
            id="opengrep-budget"
            className="text-input"
            style={{ width: 90 }}
            type="number"
            min={8}
            max={2048}
            value={draft.digestBudgetKb}
            disabled={!projectLoaded}
            onChange={(e) => patchDraft({ digestBudgetKb: e.target.value })}
          />
        </div>
        <div className="tools-textareas">
          <label className="tools-textarea">
            <span>Ignored rule ids</span>
            <textarea
              value={draft.ignoreRuleIds}
              disabled={!projectLoaded}
              placeholder={'one per line, e.g.\nmissing-template-string-indicator'}
              onChange={(e) => patchDraft({ ignoreRuleIds: e.target.value })}
            />
          </label>
          <label className="tools-textarea">
            <span>Ignored fingerprints</span>
            <textarea
              value={draft.ignoreFingerprints}
              disabled={!projectLoaded}
              placeholder={'one per line, the short fp from the digest'}
              onChange={(e) => patchDraft({ ignoreFingerprints: e.target.value })}
            />
          </label>
          <label className="tools-textarea">
            <span>Extra rule paths</span>
            <textarea
              value={draft.extraRulePaths}
              disabled={!projectLoaded}
              placeholder={'one per line, absolute or project-relative\n(.opengrep/rules is always loaded)'}
              onChange={(e) => patchDraft({ extraRulePaths: e.target.value })}
            />
          </label>
          <label className="tools-textarea">
            <span>Exclude globs</span>
            <textarea
              value={draft.excludeGlobs}
              disabled={!projectLoaded}
              placeholder={'one per line, gitignore syntax\n(gitignored and build dirs are already skipped)'}
              onChange={(e) => patchDraft({ excludeGlobs: e.target.value })}
            />
          </label>
        </div>
      </SettingsSection>

      <SettingsSection title="Scan now">
        <div className="settings-control-row">
          <button
            className="btn-primary"
            disabled={!activeFolder || !engine || scanning || status?.project?.scanning === true}
            onClick={() => void onScan()}
            title={engine ? 'Scan the active project with the enabled packs' : 'Install Opengrep first'}
          >
            {scanning || status?.project?.scanning ? 'Scanning…' : 'Run scan'}
          </button>
          {status?.project?.lastScan && !scanResult && (
            <span className="settings-section-sub">
              Last scan {formatWhen(status.project.lastScan.startedAt)}: {describeScan(status.project.lastScan)}
            </span>
          )}
        </div>
        {scanError && <div className="error-msg">{scanError}</div>}
        {scanResult && (
          <div className="tools-scan-result">
            <div>{describeScan(scanResult.scan)}</div>
            <div className="settings-section-sub">
              Digest: {scanResult.digest.shown} shown across {scanResult.digest.rules} rules (
              {scanResult.digest.bySeverity.ERROR} ERROR / {scanResult.digest.bySeverity.WARNING} WARNING /{' '}
              {scanResult.digest.bySeverity.INFO} INFO), {formatBytes(scanResult.digest.bytes)};{' '}
              {scanResult.digest.dropped.belowFloor} below the floor, {scanResult.digest.dropped.ignoredRules} from ignored
              rules, {scanResult.digest.dropped.ignoredFingerprints} ignored fingerprints
              {scanResult.digest.partiallyParsed ? `, ${scanResult.digest.partiallyParsed} files partially parsed` : ''}.
            </div>
            <a
              className="tools-pack-link"
              href={`/api/opengrep/scans/${encodeURIComponent(scanResult.scan.id)}?project=${encodeURIComponent(activeFolder)}&format=md`}
              target="_blank"
              rel="noreferrer"
            >
              open the digest
            </a>
          </div>
        )}
      </SettingsSection>
    </>
  );
});
