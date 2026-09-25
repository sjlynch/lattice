import type { OpengrepSeverity } from '../../../api';
import { SettingsSection } from '../SettingsSection';
import { SEVERITIES, type ProjectDraft } from './toolsTabUtils';

type Props = {
  activeFolder: string;
  draft: ProjectDraft;
  projectLoaded: boolean;
  projectLoadError: string | null;
  patchDraft: (p: Partial<ProjectDraft>) => void;
};

// "Scan filter (this project)": the per-project digest filter, saved with the
// footer. Every control stays disabled until the project's settings loaded.
export function OpengrepScanFilterSection({
  activeFolder,
  draft,
  projectLoaded,
  projectLoadError,
  patchDraft,
}: Props) {
  return (
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
      {projectLoadError && <div className="error-msg">{projectLoadError}</div>}
      {!activeFolder && (
        <div className="settings-section-sub">Open a project to edit its scan filter.</div>
      )}
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
  );
}
