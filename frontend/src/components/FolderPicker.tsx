import { useEffect } from 'react';
import { DriveSelector } from './folderPicker/DriveSelector';
import { CreateFolderRow } from './folderPicker/CreateFolderRow';
import { DirectoryList } from './folderPicker/DirectoryList';
import { PathRow } from './folderPicker/PathRow';
import { rootKey } from './folderPicker/rootKey';
import { useFolderPickerState } from './folderPicker/useFolderPickerState';
import { Modal } from './Modal';

type Props = {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export { rootKey };

export function FolderPicker({ open, initialPath, onClose, onSelect }: Props) {
  const {
    pathInput,
    setPathInput,
    listing,
    selectedPath,
    setSelectedPath,
    newFolderName,
    setNewFolderName,
    initGit,
    setInitGit,
    loading,
    creating,
    error,
    notice,
    load,
    createFolder,
  } = useFolderPickerState({ open, initialPath });

  const roots = listing?.roots ?? [];
  const activeRoot = listing ? rootKey(listing.path) : '';

  // Commit the current selection: the highlighted row, or — with nothing
  // highlighted — the folder we're currently inside. The only path to a
  // project switch (footer button + Enter).
  const selectedEntry = selectedPath
    ? listing?.entries.find((e) => e.path === selectedPath) ?? null
    : null;
  const commit = () => {
    if (!listing) return;
    onSelect(selectedPath ?? listing.path);
  };

  // Enter confirms the selection, mirroring the footer button. Skip it while
  // typing in the path / new-folder inputs (they handle Enter themselves).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (!listing) return;
      onSelect(selectedPath ?? listing.path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, listing, selectedPath, onSelect]);

  return (
    <Modal open={open} onClose={onClose}>
      <div className="modal-header">Select active folder</div>
      <div className="modal-body">
        <PathRow
          pathInput={pathInput}
          onPathInputChange={setPathInput}
          canGoUp={Boolean(listing?.parent)}
          onUp={() => listing?.parent && load(listing.parent)}
          onGo={() => load(pathInput)}
        />

        <DriveSelector roots={roots} activeRoot={activeRoot} onSelect={load} />

        <CreateFolderRow
          newFolderName={newFolderName}
          onNewFolderNameChange={setNewFolderName}
          creating={creating}
          canCreate={Boolean(listing)}
          initGit={initGit}
          onInitGitChange={setInitGit}
          onCreateFolder={createFolder}
        />

        {notice && <div className="git-setup-inline-note">{notice}</div>}
        {error && <div className="error-msg">{error}</div>}

        <DirectoryList
          loading={loading}
          listing={listing}
          selectedPath={selectedPath}
          onNavigate={load}
          onHighlight={setSelectedPath}
        />
      </div>
      <div className="modal-footer">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={!listing}
          // No listing = nothing to select yet; say so rather than leaving a
          // greyed button with no explanation.
          title={listing ? undefined : 'Browse to a folder first'}
          aria-label={listing ? undefined : 'Browse to a folder first'}
          onClick={commit}
        >
          {selectedEntry ? `Select ${selectedEntry.name}` : 'Select this folder'}
        </button>
      </div>
    </Modal>
  );
}
