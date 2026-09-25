import { useCallback, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { Modal } from '../Modal';
import {
  HttpError,
  initProjectGit,
  type ProjectGitProbe,
  type ProjectInitPreview,
} from '../../api';
import {
  describeProbeBlocker,
  formatBytes,
  formatFileCount,
  hasLargeEntry,
} from './gitSetupDerive';
import { useInitPreview } from './useInitPreview';

// The blocker and empty-folder dialogs are short; the adopt path widens to fit
// the counts, the largest-files list and the .gitignore textarea.
const NARROW_DIALOG_WIDTH = 460;
const WIDE_DIALOG_WIDTH = 620;
const HEADER_ICON_SIZE = 13;

type Props = {
  project: string;
  probe: ProjectGitProbe;
  onDone: (initialized: boolean) => void;
};

// Rendered only while the provider has a pending request, so `open` is always
// true and remounting (via a fresh key) is what resets its state.
export function GitSetupDialog({ project, probe, onDone }: Props) {
  // `none` + `initable` is the ONLY state that may create a repo; an unborn
  // `repo` (no commits) may FINISH one — same dialog, the backend skips
  // `git init`. Everything else — most importantly `nested` — gets an
  // explanation and nothing more.
  if (probe.initable && (probe.state === 'none' || (probe.state === 'repo' && probe.unborn))) {
    return <InitDialog project={project} onDone={onDone} />;
  }
  return <BlockerDialog probe={probe} onDone={onDone} />;
}

function BlockerDialog({
  probe,
  onDone,
}: {
  probe: ProjectGitProbe;
  onDone: (initialized: boolean) => void;
}) {
  const { title, lines } = describeProbeBlocker(probe);
  return (
    <Modal open onClose={() => onDone(false)} width={NARROW_DIALOG_WIDTH}>
      <div className="modal-header git-setup-header">
        <GitBranch size={HEADER_ICON_SIZE} />
        {title}
      </div>
      <div className="modal-body">
        {lines.map((line) => (
          <p key={line} className="git-setup-line">
            {line}
          </p>
        ))}
      </div>
      <div className="modal-footer">
        <button className="btn-primary" autoFocus onClick={() => onDone(false)}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function InitDialog({
  project,
  onDone,
}: {
  project: string;
  onDone: (initialized: boolean) => void;
}) {
  const { preview, gitignore, editGitignore, loading, refreshing, error, setError } =
    useInitPreview(project);
  const [busy, setBusy] = useState(false);
  const [identityDetail, setIdentityDetail] = useState<string | null>(null);

  const runInit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setIdentityDetail(null);
    try {
      await initProjectGit(project, gitignore ?? undefined);
      // Success unmounts this dialog, so no state is settled afterwards.
      onDone(true);
    } catch (err) {
      // 422 is git refusing to commit until it knows who you are. Git's own
      // stderr already spells out the exact commands, and the backend is barred
      // by a guard test from naming those config keys in its source — so the
      // fix reaches the user by forwarding that text verbatim from here.
      if (err instanceof HttpError && err.status === 422) {
        setIdentityDetail(err.detail?.trim() || err.message);
      } else {
        setError((err as Error).message);
      }
      setBusy(false);
    }
  }, [busy, gitignore, onDone, project, setError]);

  const close = useCallback(() => {
    if (!busy) onDone(false);
  }, [busy, onDone]);

  // Assume the light path until we know otherwise: a preview that resolves to
  // `isEmpty` shouldn't make the dialog shrink underneath the user.
  const isEmpty = preview?.isEmpty ?? true;

  return (
    <Modal open onClose={close} width={isEmpty ? NARROW_DIALOG_WIDTH : WIDE_DIALOG_WIDTH}>
      <div className="modal-header git-setup-header">
        <GitBranch size={HEADER_ICON_SIZE} />
        Set up Git
      </div>
      <div className="modal-body">
        {loading && (
          <div className="git-setup-loading">
            <span className="spinner" /> Looking at this folder…
          </div>
        )}
        {!loading && preview && (
          <>
            <p className="git-setup-line">
              Initialize a git repo here so Lattice can run tasks in worktrees.
            </p>
            {preview.isEmpty ? (
              <p className="git-setup-hint">
                This folder is empty, so this just creates the repository on{' '}
                <code>main</code> with a starter <code>.gitignore</code> and a
                first commit.
              </p>
            ) : (
              <AdoptBody
                preview={preview}
                gitignore={gitignore ?? ''}
                refreshing={refreshing}
                onGitignoreChange={editGitignore}
              />
            )}
          </>
        )}
        {identityDetail && <IdentityHelp detail={identityDetail} />}
        {error && <div className="error-msg">{error}</div>}
      </div>
      <div className="modal-footer">
        <button className="btn-ghost" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={() => void runInit()}
          disabled={busy || loading || !preview}
        >
          {busy && <span className="spinner" />}
          {busy ? 'Setting up…' : 'Set up Git'}
        </button>
      </div>
    </Modal>
  );
}

// The "adopt this folder" path: the first commit can capture a `.env` or a
// vendored dependency tree, so the counts and the editable exclude list are
// mandatory here (and deliberately absent from the empty-folder path).
function AdoptBody({
  preview,
  gitignore,
  refreshing,
  onGitignoreChange,
}: {
  preview: ProjectInitPreview;
  gitignore: string;
  refreshing: boolean;
  onGitignoreChange: (next: string) => void;
}) {
  return (
    <>
      <div className="git-setup-stat">
        <span>
          <strong>First commit:</strong>{' '}
          {formatFileCount(preview.fileCount, preview.truncated)} files,{' '}
          {formatBytes(preview.byteCount)}
          {preview.truncated ? '+' : ''}
        </span>
        {refreshing && <span className="spinner git-setup-stat-spinner" />}
      </div>
      {preview.truncated && (
        <div className="git-setup-note">
          The scan stopped at its limit, so those are lower bounds — there may be
          more.
        </div>
      )}
      {hasLargeEntry(preview.largest) && (
        <div className="git-setup-largest">
          <div className="git-setup-largest-title">Largest files</div>
          <ul className="git-setup-largest-list">
            {preview.largest.map((entry) => (
              <li key={entry.path}>
                <span className="git-setup-largest-path" title={entry.path}>
                  {entry.path}
                </span>
                <span className="git-setup-largest-bytes">
                  {formatBytes(entry.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="git-setup-field">
        <span className="git-setup-field-label">
          <code>.gitignore</code>
          <span className="git-setup-field-hint">
            {preview.generated
              ? 'Generated by Lattice — this folder has none yet.'
              : "Loaded from this folder's .gitignore."}
          </span>
        </span>
        <textarea
          className="git-setup-textarea"
          value={gitignore}
          spellCheck={false}
          rows={10}
          onChange={(e) => onGitignoreChange(e.target.value)}
        />
      </label>
      <p className="git-setup-hint">
        Exclude anything that shouldn't be committed and the count above updates
        as you type. Secrets and dependency folders are the ones worth catching.
      </p>
    </>
  );
}

function IdentityHelp({ detail }: { detail: string }) {
  return (
    <div className="git-setup-identity">
      <div className="git-setup-identity-title">
        Git needs to know who you are before it can commit.
      </div>
      <p className="git-setup-hint">
        Run this in a terminal, then press Set up Git again:
      </p>
      <pre className="git-setup-detail">{detail}</pre>
    </div>
  );
}
