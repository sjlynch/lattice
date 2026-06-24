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
    newFolderName,
    setNewFolderName,
    loading,
    creating,
    error,
    load,
    createFolder,
  } = useFolderPickerState({ open, initialPath });

  const roots = listing?.roots ?? [];
  const activeRoot = listing ? rootKey(listing.path) : '';

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
          onCreateFolder={createFolder}
        />

        {error && <div className="error-msg">{error}</div>}

        <DirectoryList
          loading={loading}
          listing={listing}
          onNavigate={load}
          onSelect={onSelect}
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
          onClick={() => listing && onSelect(listing.path)}
        >
          Select this folder
        </button>
      </div>
    </Modal>
  );
}
