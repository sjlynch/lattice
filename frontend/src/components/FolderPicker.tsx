import { useEffect, useState } from 'react';
import { ArrowUp, Folder, FolderPlus, HardDrive } from 'lucide-react';
import { createDir, listDir, type DirListing } from '../api';
import { Modal } from './Modal';

type Props = {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

function rootKey(folderPath: string): string {
  const winDrive = folderPath.match(/^([A-Za-z]:)[\\/]/);
  if (winDrive) return winDrive[1].toUpperCase();
  if (folderPath.startsWith('/')) return '/';
  return folderPath;
}

export function FolderPicker({ open, initialPath, onClose, onSelect }: Props) {
  const [pathInput, setPathInput] = useState(initialPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(target?: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await listDir(target);
      setListing(result);
      setPathInput(result.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateFolder() {
    if (!listing) return;
    const folderName = newFolderName.trim();
    if (!folderName) {
      setError('Enter a folder name.');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const result = await createDir(listing.path, folderName);
      setListing(result);
      setPathInput(result.path);
      setNewFolderName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (open) load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const roots = listing?.roots ?? [];
  const activeRoot = listing ? rootKey(listing.path) : '';

  return (
    <Modal open={open} onClose={onClose}>
      <div className="modal-header">Select active folder</div>
      <div className="modal-body">
        <div className="path-row">
          <button
            className="icon-btn"
            onClick={() => listing?.parent && load(listing.parent)}
            disabled={!listing?.parent}
            title="Up one level"
            aria-label="Up one level"
          >
            <ArrowUp size={14} />
          </button>
          <input
            className="text-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') load(pathInput);
            }}
            spellCheck={false}
          />
          <button className="btn-ghost" onClick={() => load(pathInput)}>
            Go
          </button>
        </div>

        {roots.length > 1 && (
          <div className="drive-row" aria-label="Available drives">
            <span className="drive-row-label">Drives</span>
            <div className="drive-list">
              {roots.map((root) => (
                <button
                  key={root.path}
                  className={`drive-chip${rootKey(root.path) === activeRoot ? ' active' : ''}`}
                  onClick={() => load(root.path)}
                  title={root.path}
                >
                  <HardDrive size={12} />
                  {root.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="create-folder-row">
          <input
            className="text-input create-folder-input"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
            }}
            placeholder="New folder name"
            disabled={!listing || creating}
            spellCheck={false}
          />
          <button
            className="btn-ghost"
            onClick={handleCreateFolder}
            disabled={!listing || creating || !newFolderName.trim()}
          >
            <FolderPlus size={14} />
            {creating ? 'Creating…' : 'Create folder'}
          </button>
        </div>

        {error && <div className="error-msg">{error}</div>}

        <div className="dir-list">
          {loading && !listing && (
            <div className="dir-list-empty">Loading…</div>
          )}
          {listing && listing.entries.length === 0 && (
            <div className="dir-list-empty">No subfolders here</div>
          )}
          {listing &&
            listing.entries.map((e) => (
              <div
                key={e.path}
                className="dir-row"
                onClick={() => load(e.path)}
                onDoubleClick={() => onSelect(e.path)}
              >
                <span className="dir-icon">
                  <Folder size={14} />
                </span>
                <span>{e.name}</span>
              </div>
            ))}
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={!listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          Select this folder
        </button>
      </div>
    </Modal>
  );
}
