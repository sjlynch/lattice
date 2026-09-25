import {
  installOpengrepRulePack,
  removeOpengrepRulePack,
  type OpengrepStatus,
} from '../../../api';
import { SettingsSection } from '../SettingsSection';
import type { useConfirm } from '../../shared/ConfirmDialog';
import { needsLicenceAcknowledgement } from './toolsTabUtils';

type Props = {
  status: OpengrepStatus | null;
  packDraft: Record<string, boolean>;
  packLoaded: boolean;
  packLoadError: string | null;
  setPackEnabled: (packId: string, enabled: boolean) => void;
  runAction: (fn: () => Promise<unknown>) => Promise<void>;
  confirm: ReturnType<typeof useConfirm>['confirm'];
};

// "Rule packs": one row per pack — the machine-global enable checkbox (saved
// with the footer) and the install / update / remove buttons (immediate).
export function OpengrepPacksSection({
  status,
  packDraft,
  packLoaded,
  packLoadError,
  setPackEnabled,
  runAction,
  confirm,
}: Props) {
  return (
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
      {packLoadError && <div className="error-msg">{packLoadError}</div>}
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
                  onChange={(e) => setPackEnabled(p.id, e.target.checked)}
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
  );
}
