import { useEffect, useState } from 'react';
import { ArrowUp, Folder } from 'lucide-react';
import { listDir, type DirListing } from '../api';
import { Modal } from './Modal';

type Props = {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function FolderPicker({ open, initialPath, onClose, onSelect }: Props) {
  const [pathInput, setPathInput] = useState(initialPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
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

  useEffect(() => {
    if (open) load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
