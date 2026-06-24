import { Folder } from 'lucide-react';
import type { DirEntry, DirListing } from '../../api';

type DirectoryListProps = {
  loading: boolean;
  listing: DirListing | null;
  selectedPath: string | null;
  onNavigate: (path: string) => void;
  onHighlight: (path: string) => void;
};

type DirectoryRowProps = {
  entry: DirEntry;
  selected: boolean;
  onNavigate: (path: string) => void;
  onHighlight: (path: string) => void;
};

function DirectoryRow({ entry, selected, onNavigate, onHighlight }: DirectoryRowProps) {
  return (
    <div
      className={selected ? 'dir-row selected' : 'dir-row'}
      onClick={() => onHighlight(entry.path)}
      onDoubleClick={() => onNavigate(entry.path)}
    >
      <span className="dir-icon">
        <Folder size={14} />
      </span>
      <span>{entry.name}</span>
    </div>
  );
}

export function DirectoryList({
  loading,
  listing,
  selectedPath,
  onNavigate,
  onHighlight,
}: DirectoryListProps) {
  return (
    <div className="dir-list">
      {loading && !listing && (
        <div className="dir-list-empty">Loading…</div>
      )}
      {listing && listing.entries.length === 0 && (
        <div className="dir-list-empty">No subfolders here</div>
      )}
      {listing &&
        listing.entries.map((entry) => (
          <DirectoryRow
            key={entry.path}
            entry={entry}
            selected={entry.path === selectedPath}
            onNavigate={onNavigate}
            onHighlight={onHighlight}
          />
        ))}
    </div>
  );
}
