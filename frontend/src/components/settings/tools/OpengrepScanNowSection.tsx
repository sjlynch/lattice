import type { OpengrepScanEnvelope, OpengrepStatus } from '../../../api';
import { SettingsSection } from '../SettingsSection';
import { describeScan, formatBytes, formatWhen } from './toolsTabUtils';

type Props = {
  activeFolder: string;
  status: OpengrepStatus | null;
  scanning: boolean;
  scanResult: OpengrepScanEnvelope | null;
  scanError: string | null;
  onScan: () => Promise<void>;
};

// "Scan now": runs a scan of the active project and shows its record + digest
// counts (or the last stored scan) with a link to the markdown digest.
export function OpengrepScanNowSection({
  activeFolder,
  status,
  scanning,
  scanResult,
  scanError,
  onScan,
}: Props) {
  const engine = status?.engine ?? null;

  return (
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
  );
}
